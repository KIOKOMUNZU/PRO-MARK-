const express=require('express');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const db=require('../db');
const router=express.Router();
const {authenticate}=require('../middleware/auth');

async function tableColumns(table){
  const q=await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,[table]);
  return new Set(q.rows.map(r=>r.column_name));
}

router.post('/login',async(req,res)=>{
  try{
    const email=String(req.body.email||'').trim().toLowerCase();
    const password=String(req.body.password||'');
    const requestedRole=String(req.body.role||'').trim().toUpperCase();
    const requestedSchoolId=String(req.body.school_id||'').trim();
    if(!email||!password)return res.status(400).json({error:'Email and password are required'});

    // IMPORTANT: existing PRO-MARK installations are not all on the same schema.
    // Login must therefore discover optional columns/tables instead of assuming
    // the newest schema. This prevents a database-column mismatch from becoming
    // a generic HTTP 500 during login.
    const usersCols=await tableColumns('users');
    if(!usersCols.has('email')||!usersCols.has('password_hash')){
      return res.status(500).json({error:'The users table is missing the required email/password columns.'});
    }

    const uq=await db.query(`SELECT id,email,password_hash,${usersCols.has('first_name')?'first_name':'NULL::text AS first_name'},${usersCols.has('last_name')?'last_name':'NULL::text AS last_name'},${usersCols.has('is_active')?'is_active':'true AS is_active'} FROM users WHERE LOWER(email)=$1 LIMIT 1`,[email]);
    if(!uq.rows.length)return res.status(401).json({error:'Invalid email or password'});
    const base=uq.rows[0];
    if(base.is_active===false)return res.status(403).json({error:'This account is inactive.'});
    if(!base.password_hash || !(await bcrypt.compare(password,base.password_hash)))return res.status(401).json({error:'Invalid email or password'});

    const roleRows=[];
    const roleCols=await tableColumns('user_school_roles');
    if(roleCols.size){
      const hasSchool=roleCols.has('school_id');
      const hasMark=roleCols.has('mark_entry_enabled');
      const hasCreated=roleCols.has('created_at');
      const rq=await db.query(`SELECT id,user_id,${hasSchool?'school_id':'NULL::uuid AS school_id'},role,${hasMark?'mark_entry_enabled':'true AS mark_entry_enabled'},${hasCreated?'created_at':'NULL::timestamptz AS created_at'} FROM user_school_roles WHERE user_id=$1`,[base.id]);
      roleRows.push(...rq.rows.map(r=>({role:String(r.role).toUpperCase(),school_id:r.school_id||null,mark_entry_enabled:r.mark_entry_enabled!==false,created_at:r.created_at,id:r.id})));
    }

    // Older installations may have teacher accounts linked through teachers.user_id
    // before a user_school_roles row was created. Use that link as a safe fallback.
    const teacherCols=await tableColumns('teachers');
    if(teacherCols.has('user_id')&&teacherCols.has('school_id')){
      const tq=await db.query(`SELECT id,school_id FROM teachers WHERE user_id=$1 ${teacherCols.has('is_active')?'AND is_active=true':''} LIMIT 50`,[base.id]);
      for(const t of tq.rows){
        if(!roleRows.some(r=>r.role==='TEACHER'&&String(r.school_id||'')===String(t.school_id||''))){
          roleRows.push({role:'TEACHER',school_id:t.school_id||null,mark_entry_enabled:true,created_at:null,id:`teacher:${t.id}`});
        }
      }
    }

    if(!roleRows.length)return res.status(403).json({error:'This account is not assigned a PRO-MARK role. Ask an administrator to assign a role.'});

    let candidates=roleRows;
    if(requestedRole)candidates=candidates.filter(r=>r.role===requestedRole);
    if(requestedSchoolId)candidates=candidates.filter(r=>String(r.school_id||'')===requestedSchoolId);
    if(!candidates.length)return res.status(403).json({error:'The selected role or school is not assigned to this account.'});

    // Build school metadata only after the role has been identified. Support both
    // the current schools(name/status) schema and older school_name/active schemas.
    const schoolCols=await tableColumns('schools');
    const schoolMap=new Map();
    const schoolIds=[...new Set(candidates.map(r=>r.school_id).filter(Boolean))];
    if(schoolIds.length&&schoolCols.has('id')){
      const nameExpr=schoolCols.has('name')?'name':(schoolCols.has('school_name')?'school_name':"''");
      const statusExpr=schoolCols.has('status')?'status':(schoolCols.has('active')?`CASE WHEN active THEN 'ACTIVE' ELSE 'INACTIVE' END`:"'ACTIVE'");
      const sq=await db.query(`SELECT id,${nameExpr} AS school_name,${statusExpr} AS school_status FROM schools WHERE id = ANY($1::uuid[])`,[schoolIds]);
      sq.rows.forEach(s=>schoolMap.set(String(s.id),s));
    }

    const enriched=candidates.map(r=>{const s=schoolMap.get(String(r.school_id||''));return {...r,school_name:s?.school_name||null,school_status:String(s?.school_status||'ACTIVE').toUpperCase()};});
    const unique=[...new Map(enriched.map(x=>[`${x.role}::${x.school_id||''}`,x])).values()];

    if(unique.length>1&&!requestedRole){
      return res.status(409).json({error:'This email has more than one PRO-MARK role. Select the intended role and school.',roles:unique.map(x=>({role:x.role,school_id:x.school_id,school_name:x.school_name}))});
    }
    if(unique.length>1&&requestedRole&&!requestedSchoolId){
      const sameRole=unique.filter(x=>x.role===requestedRole);
      if(sameRole.length>1)return res.status(409).json({error:'This role is assigned to more than one school. Select the intended school.',roles:sameRole.map(x=>({role:x.role,school_id:x.school_id,school_name:x.school_name}))});
    }

    // If a role was requested, use that exact candidate; otherwise use the first.
    const chosen=unique.find(x=>(!requestedRole||x.role===requestedRole)&&(!requestedSchoolId||String(x.school_id||'')===requestedSchoolId))||unique[0];
    if(chosen.school_id&&chosen.school_status!=='ACTIVE')return res.status(403).json({error:`School is ${String(chosen.school_status).toLowerCase()}`});

    const user={
      id:base.id,email:base.email,first_name:base.first_name||'',last_name:base.last_name||'',
      role:chosen.role,school_id:chosen.school_id||null,school_name:chosen.school_name||null,
      mark_entry_enabled:chosen.mark_entry_enabled!==false
    };
    const token=jwt.sign({user_id:base.id,email:base.email,role:chosen.role,school_id:chosen.school_id||null},process.env.JWT_SECRET,{expiresIn:'8h'});
    return res.json({token,user});
  }catch(e){
    console.error('LOGIN ERROR:',e && e.stack ? e.stack : e);
    return res.status(500).json({error:'Login failed. Check the server console for the exact database error.'});
  }
});

// Authenticated self-service password change. Existing password hashes are never exposed.
router.post('/change-password',authenticate,async(req,res)=>{
  try{
    const current=String(req.body?.current_password||'');
    const next=String(req.body?.new_password||'');
    if(next.length<10)return res.status(400).json({error:'New password must be at least 10 characters.'});
    const q=await db.query('SELECT password_hash FROM users WHERE id=$1',[req.user.user_id]);
    if(!q.rows[0])return res.status(404).json({error:'User account not found.'});
    if(!current || !(await bcrypt.compare(current,q.rows[0].password_hash)))return res.status(401).json({error:'Current password is incorrect.'});
    const hash=await bcrypt.hash(next,12);
    await db.query('UPDATE users SET password_hash=$2,updated_at=now() WHERE id=$1',[req.user.user_id,hash]);
    res.json({ok:true,message:'Password changed successfully.'});
  }catch(e){console.error('CHANGE PASSWORD ERROR:',e);res.status(500).json({error:'Unable to change password.'});}
});

module.exports=router;
