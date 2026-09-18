const express=require('express'),bcrypt=require('bcryptjs'),db=require('../db'),fs=require('fs'),path=require('path');
const {authenticate,roles,schoolBoundary}=require('../middleware/auth');
const {assertBelongs}=require('../services/tenant');
const {source:assetSource}=require('../services/assets');
const router=express.Router();router.use(authenticate);
const clean=v=>String(v??'').trim();
const MANAGED_ROLES=['SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'];
const UNIQUE_ROLES=new Set(['SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER']);

// USER / ROLE CONTROL
// School administrators can activate/deactivate accounts, enable/disable Mark Entry,
// and move one person between the platform's school roles. PLATFORM_OWNER is allowed
// by the global roles() middleware and can therefore manage any school.
router.get('/:schoolId/user-roles',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
  try{
    const q=await db.query(`
      SELECT u.id user_id,u.email,u.first_name,u.last_name,u.is_active,
             r.id role_id,r.role,r.mark_entry_enabled,r.created_at role_created_at,
             t.id teacher_id,t.staff_no,t.is_active teacher_active
      FROM users u
      JOIN user_school_roles r ON r.user_id=u.id AND r.school_id=$1
      LEFT JOIN teachers t ON t.user_id=u.id AND t.school_id=$1
      ORDER BY u.last_name,u.first_name,u.email,r.role`,[req.params.schoolId]);
    res.json(q.rows);
  }catch(e){res.status(500).json({error:'Unable to load user and role control.'});}
});

router.patch('/:schoolId/user-roles/:roleId',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
  const sid=req.params.schoolId,b=req.body||{},c=await db.pool.connect();
  try{
    const current=(await c.query(`
      SELECT r.id,r.user_id,r.school_id,r.role,u.email
      FROM user_school_roles r JOIN users u ON u.id=r.user_id
      WHERE r.id=$1 AND r.school_id=$2`,[req.params.roleId,sid])).rows[0];
    if(!current)return res.status(404).json({error:'User role not found.'});

    await c.query('BEGIN');

    if(typeof b.is_active==='boolean'){
      await c.query('UPDATE users SET is_active=$2 WHERE id=$1',[current.user_id,b.is_active]);
      await c.query('UPDATE teachers SET is_active=$2 WHERE user_id=$1 AND school_id=$3',[current.user_id,b.is_active,sid]);
    }

    if(typeof b.mark_entry_enabled==='boolean'){
      await c.query('UPDATE user_school_roles SET mark_entry_enabled=$2 WHERE id=$1',[current.id,b.mark_entry_enabled]);
    }

    if(b.role!==undefined){
      const next=String(b.role||'').toUpperCase();
      if(!MANAGED_ROLES.includes(next))throw Object.assign(new Error('Invalid school role.'),{status:400});
      if(UNIQUE_ROLES.has(next)){
        const conflict=(await c.query(`
          SELECT u.email,r.role FROM user_school_roles r JOIN users u ON u.id=r.user_id
          WHERE r.school_id=$1 AND r.role=$2 AND r.id<>$3
          LIMIT 1`,[sid,next,current.id])).rows[0];
        if(conflict)throw Object.assign(new Error(`${next.replaceAll('_',' ')} is already assigned to ${conflict.email}. Remove that role first.`),{status:409});
      }
      // One active school role per person. The person remains a teacher profile
      // and their assignments remain intact when changing leadership role.
      await c.query('DELETE FROM user_school_roles WHERE user_id=$1 AND school_id=$2 AND id<>$3',[current.user_id,sid,current.id]);
      await c.query('UPDATE user_school_roles SET role=$2 WHERE id=$1',[current.id,next]);
    }

    const out=(await c.query(`
      SELECT u.id user_id,u.email,u.first_name,u.last_name,u.is_active,
             r.id role_id,r.role,r.mark_entry_enabled,
             t.id teacher_id,t.staff_no,t.is_active teacher_active
      FROM users u JOIN user_school_roles r ON r.user_id=u.id
      LEFT JOIN teachers t ON t.user_id=u.id AND t.school_id=$2
      WHERE r.id=$1 AND r.school_id=$2`,[current.id,sid])).rows[0];

    await c.query('COMMIT');
    res.json(out);
  }catch(e){try{await c.query('ROLLBACK')}catch{}res.status(e.status||400).json({error:e.message});}
  finally{c.release();}
});

router.delete('/:schoolId/user-roles/:roleId',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
  const sid=req.params.schoolId,c=await db.pool.connect();
  try{
    const r=(await c.query(`
      SELECT r.id,r.user_id,r.role,u.email
      FROM user_school_roles r JOIN users u ON u.id=r.user_id
      WHERE r.id=$1 AND r.school_id=$2`,[req.params.roleId,sid])).rows[0];
    if(!r)return res.status(404).json({error:'User role not found.'});
    if(r.user_id===req.user.user_id) return res.status(400).json({error:'You cannot remove your own active school role. Another administrator must do this.'});
    await c.query('BEGIN');
    await c.query('DELETE FROM user_school_roles WHERE id=$1 AND school_id=$2',[r.id,sid]);
    // Removing a school role does not delete the person, teacher profile, marks,
    // assignments or audit history. The account can be assigned another role later.
    await c.query('COMMIT');
    res.json({ok:true,removed_role:r.role,email:r.email});
  }catch(e){try{await c.query('ROLLBACK')}catch{}res.status(400).json({error:e.message});}
  finally{c.release();}
});


// Administrator reset for a school user. The existing password is never readable.
router.post('/:schoolId/user-roles/:roleId/reset-password',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
  try{
    const r=(await db.query(`SELECT r.user_id,u.email FROM user_school_roles r JOIN users u ON u.id=r.user_id WHERE r.id=$1 AND r.school_id=$2`,[req.params.roleId,req.params.schoolId])).rows[0];
    if(!r)return res.status(404).json({error:'User role not found.'});
    const supplied=String(req.body?.new_password||'').trim();
    const temp=supplied||('PM-'+require('crypto').randomBytes(9).toString('base64url')+'9');
    if(temp.length<10)return res.status(400).json({error:'Password must be at least 10 characters.'});
    const hash=await bcrypt.hash(temp,12);
    await db.query('UPDATE users SET password_hash=$2,is_active=true,updated_at=now() WHERE id=$1',[r.user_id,hash]);
    res.json({ok:true,email:r.email,temporary_password:temp});
  }catch(e){res.status(400).json({error:e.message});}
});

// SCHOOL LEADERSHIP ROLE ROUTES
router.get('/:schoolId/leadership',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER'),async(req,res)=>{
 try{res.json((await db.query(`SELECT r.id role_id,r.role,u.id user_id,u.email,u.first_name,u.last_name,t.id teacher_id,t.staff_no FROM user_school_roles r JOIN users u ON u.id=r.user_id LEFT JOIN teachers t ON t.user_id=u.id AND t.school_id=r.school_id WHERE r.school_id=$1 AND r.role IN ('HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER') AND u.is_active=true ORDER BY CASE r.role WHEN 'HEADTEACHER' THEN 1 WHEN 'DEPUTY_HEADTEACHER' THEN 2 ELSE 3 END,u.last_name,u.first_name`,[req.params.schoolId])).rows)}catch(e){res.status(400).json({error:e.message});}
});
router.post('/:schoolId/leadership',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
 const sid=req.params.schoolId,b=req.body||{},c=await db.pool.connect(); try{
  const role=String(b.role||'').toUpperCase(); if(!['HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER'].includes(role))return res.status(400).json({error:'Invalid leadership role.'});
  await assertBelongs('teachers',b.teacher_id,sid); await c.query('BEGIN');
  const t=(await c.query(`SELECT id,user_id,is_active FROM teachers WHERE id=$1 AND school_id=$2`,[b.teacher_id,sid])).rows[0];
  if(!t?.user_id||!t.is_active)throw Object.assign(new Error('The selected teacher must have an active linked login.'),{status:400});
  const conflict=(await c.query(`SELECT u.email FROM user_school_roles r JOIN users u ON u.id=r.user_id WHERE r.school_id=$1 AND r.role=$2 AND r.user_id<>$3 AND u.is_active=true LIMIT 1`,[sid,role,t.user_id])).rows[0];
  if(conflict)throw Object.assign(new Error(`${role.replaceAll('_',' ')} is already assigned to ${conflict.email}. Remove that role first.`),{status:409});
  await c.query(`DELETE FROM user_school_roles WHERE user_id=$1 AND school_id=$2`,[t.user_id,sid]);
  const out=(await c.query(`INSERT INTO user_school_roles(user_id,school_id,role,mark_entry_enabled) VALUES($1,$2,$3,true) RETURNING id role_id,role`,[t.user_id,sid,role])).rows[0]; await c.query('COMMIT'); res.status(201).json(out);
 }catch(e){try{await c.query('ROLLBACK')}catch{}res.status(e.status||400).json({error:e.message});}finally{c.release();}
});

router.get('/:schoolId/teachers',schoolBoundary,async(req,res)=>{try{res.json((await db.query(`SELECT id,staff_no,first_name,last_name,email,is_active,user_id FROM teachers WHERE school_id=$1 ORDER BY last_name,first_name`,[req.params.schoolId])).rows)}catch(e){res.status(500).json({error:'Unable to load teachers'});}});
router.post('/:schoolId/teachers',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{const b=req.body;if(!clean(b.staff_no)||!clean(b.first_name)||!clean(b.last_name))return res.status(400).json({error:'Staff number, first name and last name are required'});try{const q=await db.query(`INSERT INTO teachers(school_id,staff_no,first_name,last_name,email) VALUES($1,$2,$3,$4,$5) RETURNING *`,[req.params.schoolId,clean(b.staff_no),clean(b.first_name),clean(b.last_name),clean(b.email)||null]);res.status(201).json(q.rows[0]);}catch(e){res.status(400).json({error:e.code==='23505'?'That staff number already exists in this school.':e.message});}});
router.post('/:schoolId/teacher-accounts',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
 const b=req.body||{},sid=req.params.schoolId;
 try{
  await assertBelongs('teachers',b.teacher_id,sid);
  const email=clean(b.email).toLowerCase(),password=clean(b.password);
  const role=String(b.role||'TEACHER').toUpperCase();
  const allowed=new Set(['TEACHER','CLASS_TEACHER','SENIOR_TEACHER','HEADTEACHER','DEPUTY_HEADTEACHER']);
  if(!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<10)return res.status(400).json({error:'Enter a valid teacher email and a password of at least 10 characters'});
  if(!allowed.has(role))return res.status(400).json({error:'Invalid teacher account role.'});
  const t=(await db.query(`SELECT first_name,last_name FROM teachers WHERE id=$1 AND school_id=$2`,[b.teacher_id,sid])).rows[0];
  const hash=await bcrypt.hash(password,12);
  const u=(await db.query(`INSERT INTO users(email,password_hash,first_name,last_name) VALUES($1,$2,$3,$4)
    ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash,first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,is_active=true,updated_at=now()
    RETURNING id,email,first_name,last_name`,[email,hash,t.first_name,t.last_name])).rows[0];
  const c=await db.pool.connect();
  try{
    await c.query('BEGIN');
    await c.query(`UPDATE teachers SET email=$2,user_id=$3 WHERE id=$1 AND school_id=$4`,[b.teacher_id,email,u.id,sid]);
    const conflict=(await c.query(`SELECT u.email FROM user_school_roles r JOIN users u ON u.id=r.user_id
      WHERE r.school_id=$1 AND r.role=$2 AND r.user_id<>$3 AND u.is_active=true LIMIT 1`,[sid,role,u.id])).rows[0];
    if(conflict && ['HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER'].includes(role))throw Object.assign(new Error(`${role.replaceAll('_',' ')} is already assigned to ${conflict.email}. Remove that role first.`),{status:409});
    await c.query(`DELETE FROM user_school_roles WHERE user_id=$1 AND school_id=$2`,[u.id,sid]);
    await c.query(`INSERT INTO user_school_roles(user_id,school_id,role,mark_entry_enabled) VALUES($1,$2,$3,true)`,[u.id,sid,role]);
    await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  res.status(201).json({teacher_id:b.teacher_id,email:u.email,role});
 }catch(e){res.status(e.status||400).json({error:e.message});}
});
router.patch('/:schoolId/learners/:learnerId/identifiers',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','CLASS_TEACHER','SENIOR_TEACHER'),async(req,res)=>{
 try{
  await assertBelongs('learners',req.params.learnerId,req.params.schoolId);
  const q=await db.query(`UPDATE learners SET admission_no=$3,assessment_no=$4 WHERE id=$1 AND school_id=$2 RETURNING *`,[req.params.learnerId,req.params.schoolId,clean(req.body?.admission_no)||null,clean(req.body?.assessment_no)||null]);
  res.json(q.rows[0]);
 }catch(e){res.status(e.status||400).json({error:e.code==='23505'?'That admission number already exists in this school.':e.message});}
});
router.get('/:schoolId/learners',schoolBoundary,async(req,res)=>{try{let extra='';const params=[req.params.schoolId];if(req.user.role==='CLASS_TEACHER'){extra=` AND EXISTS (SELECT 1 FROM class_teacher_assignments cta JOIN teachers ct ON ct.id=cta.teacher_id WHERE cta.school_id=l.school_id AND cta.class_id=l.class_id AND ct.user_id=$2 AND cta.academic_year_id=(SELECT id FROM academic_years WHERE school_id=l.school_id ORDER BY year_label DESC LIMIT 1))`;params.push(req.user.user_id);}res.json((await db.query(`SELECT l.*,cl.name class_name,cl.stream,lv.name level_name,ss.name section_name FROM learners l LEFT JOIN classes cl ON cl.id=l.class_id LEFT JOIN school_levels lv ON lv.id=cl.school_level_id LEFT JOIN school_sections ss ON ss.id=lv.school_section_id WHERE l.school_id=$1${extra} ORDER BY l.last_name,l.first_name`,params)).rows)}catch(e){res.status(500).json({error:'Unable to load learners'});}});
router.post('/:schoolId/learners',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','CLASS_TEACHER','SENIOR_TEACHER'),async(req,res)=>{const b=req.body,sid=req.params.schoolId,c=await db.pool.connect();try{if(!clean(b.first_name)||!clean(b.last_name))return res.status(400).json({error:'First name and last name are required'});if(b.class_id)await assertBelongs('classes',b.class_id,sid);if(req.user.role==='CLASS_TEACHER'){if(!b.class_id)return res.status(400).json({error:'Class Teacher must select the assigned class.'});const ok=(await db.query(`SELECT 1 FROM class_teacher_assignments a JOIN teachers t ON t.id=a.teacher_id WHERE a.school_id=$1 AND t.user_id=$2 AND a.class_id=$3 AND a.academic_year_id=$4 AND (a.term_id=$5 OR a.term_id IS NULL) LIMIT 1`,[sid,req.user.user_id,b.class_id,b.academic_year_id,b.term_id||null])).rows[0];if(!ok)return res.status(403).json({error:'You can only add learners to a class assigned to you as Class Teacher.'});}await c.query('BEGIN');const l=(await c.query(`INSERT INTO learners(school_id,admission_no,assessment_no,first_name,middle_name,last_name,date_of_birth,gender,class_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[sid,clean(b.admission_no)||null,clean(b.assessment_no)||null,clean(b.first_name),clean(b.middle_name),clean(b.last_name),b.date_of_birth||null,clean(b.gender)||null,b.class_id||null])).rows[0];if(b.academic_year_id&&b.class_id){await c.query(`INSERT INTO learner_enrollments(school_id,learner_id,academic_year_id,class_id) VALUES($1,$2,$3,$4) ON CONFLICT(learner_id,academic_year_id) DO UPDATE SET class_id=EXCLUDED.class_id`,[sid,l.id,b.academic_year_id,b.class_id]);}await c.query('COMMIT');res.status(201).json(l);}catch(e){await c.query('ROLLBACK');res.status(e.status||400).json({error:e.code==='23505'?'That admission number already exists in this school.':e.message});}finally{c.release();}});
router.get('/:schoolId/classes',schoolBoundary,async(req,res)=>{try{res.json((await db.query(`SELECT c.*,lv.name level_name,ss.name section_name,(SELECT count(*) FROM learners l WHERE l.class_id=c.id AND l.is_active) learner_count FROM classes c JOIN school_levels lv ON lv.id=c.school_level_id JOIN school_sections ss ON ss.id=lv.school_section_id WHERE c.school_id=$1 AND c.is_active=true ORDER BY ss.sort_order,lv.sort_order,c.name,c.stream`,[req.params.schoolId])).rows)}catch(e){res.status(500).json({error:'Unable to load classes'});}});
router.post('/:schoolId/classes',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{const b=req.body;try{await assertBelongs('school_levels',b.school_level_id,req.params.schoolId);if(!clean(b.name))return res.status(400).json({error:'Class name is required'});const q=await db.query(`INSERT INTO classes(school_id,school_level_id,name,stream) VALUES($1,$2,$3,$4) RETURNING *`,[req.params.schoolId,b.school_level_id,clean(b.name),clean(b.stream)]);res.status(201).json(q.rows[0]);}catch(e){res.status(e.status||400).json({error:e.code==='23505'?'That class and stream already exist.':e.message});}});
// Remove an incorrectly-created class safely. A class with historical/current data is archived instead of hard-deleted.
router.delete('/:schoolId/classes/:classId',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{
 const sid=req.params.schoolId,c=await db.pool.connect();
 try{
  const cls=(await c.query('SELECT id,name,stream,is_active FROM classes WHERE id=$1 AND school_id=$2',[req.params.classId,sid])).rows[0];
  if(!cls)return res.status(404).json({error:'Class not found'});
  const counts=(await c.query(`SELECT
    (SELECT count(*) FROM learners WHERE class_id=$1) learners,
    (SELECT count(*) FROM learner_enrollments WHERE class_id=$1) enrollments,
    (SELECT count(*) FROM marks WHERE class_id=$1) marks,
    (SELECT count(*) FROM teacher_subject_assignments WHERE class_id=$1) assignments,
    (SELECT count(*) FROM class_teacher_assignments WHERE class_id=$1) class_teachers,
    (SELECT count(*) FROM learner_movement_events WHERE from_class_id=$1 OR to_class_id=$1) movements`,[cls.id])).rows[0];
  const used=Object.values(counts).some(v=>Number(v)>0);
  if(used){
    await c.query('UPDATE classes SET is_active=false WHERE id=$1 AND school_id=$2',[cls.id,sid]);
    return res.json({ok:true,action:'ARCHIVED',message:'This class has academic/history records, so it was archived rather than deleted.'});
  }
  await c.query('DELETE FROM classes WHERE id=$1 AND school_id=$2',[cls.id,sid]);
  res.json({ok:true,action:'DELETED',message:'Class removed successfully.'});
 }catch(e){res.status(400).json({error:e.message});}finally{c.release();}
});
router.patch('/:schoolId/classes/:classId/status',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{try{const active=req.body.is_active!==false;const q=await db.query('UPDATE classes SET is_active=$3 WHERE id=$1 AND school_id=$2 RETURNING *',[req.params.classId,req.params.schoolId,active]);if(!q.rows[0])return res.status(404).json({error:'Class not found'});res.json(q.rows[0]);}catch(e){res.status(400).json({error:e.message});}});

router.get('/:schoolId/subjects',schoolBoundary,async(req,res)=>{try{res.json((await db.query(`SELECT * FROM subjects WHERE school_id=$1 AND is_active ORDER BY name`,[req.params.schoolId])).rows)}catch(e){res.status(500).json({error:'Unable to load subjects'});}});
router.post('/:schoolId/subjects',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{const b=req.body;try{const code=clean(b.code).toUpperCase(),name=clean(b.name);if(!code||!name)return res.status(400).json({error:'Subject code and name are required'});const q=await db.query(`INSERT INTO subjects(school_id,code,name,subject_type) VALUES($1,$2,$3,$4) RETURNING *`,[req.params.schoolId,code,name,clean(b.subject_type)||'LEARNING_AREA']);res.status(201).json(q.rows[0]);}catch(e){res.status(400).json({error:e.code==='23505'?'That subject code already exists.':e.message});}});
router.get('/:schoolId/assignments',schoolBoundary,async(req,res)=>{try{res.json((await db.query(`SELECT a.*,t.staff_no,t.first_name teacher_first_name,t.last_name teacher_last_name,s.code subject_code,s.name subject_name,c.name class_name,c.stream,lv.name level_name,ay.year_label,tm.name term_name FROM teacher_subject_assignments a JOIN teachers t ON t.id=a.teacher_id JOIN subjects s ON s.id=a.subject_id JOIN classes c ON c.id=a.class_id JOIN school_levels lv ON lv.id=c.school_level_id JOIN academic_years ay ON ay.id=a.academic_year_id LEFT JOIN terms tm ON tm.id=a.term_id WHERE a.school_id=$1 ORDER BY ay.year_label DESC,c.name,s.name,t.last_name`,[req.params.schoolId])).rows)}catch(e){res.status(500).json({error:'Unable to load assignments'});}});
router.post('/:schoolId/assignments',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{const b=req.body||{},sid=req.params.schoolId;try{if(!b.teacher_id||!b.subject_id||!b.class_id||!b.academic_year_id)return res.status(400).json({error:'Teacher, subject, class and academic year are required.'});await assertBelongs('teachers',b.teacher_id,sid);await assertBelongs('subjects',b.subject_id,sid);await assertBelongs('classes',b.class_id,sid);await assertBelongs('academic_years',b.academic_year_id,sid);if(b.term_id)await assertBelongs('terms',b.term_id,sid);const existing=(await db.query(`SELECT id FROM teacher_subject_assignments WHERE school_id=$1 AND teacher_id=$2 AND subject_id=$3 AND class_id=$4 AND academic_year_id=$5 AND term_id IS NOT DISTINCT FROM $6::uuid LIMIT 1`,[sid,b.teacher_id,b.subject_id,b.class_id,b.academic_year_id,b.term_id||null])).rows[0];let q;if(existing){q=await db.query(`UPDATE teacher_subject_assignments SET is_active=true WHERE id=$1 RETURNING *`,[existing.id]);}else{q=await db.query(`INSERT INTO teacher_subject_assignments(school_id,teacher_id,subject_id,class_id,academic_year_id,term_id,is_class_teacher,is_active) VALUES($1,$2,$3,$4,$5,$6,false,true) RETURNING *`,[sid,b.teacher_id,b.subject_id,b.class_id,b.academic_year_id,b.term_id||null]);}res.status(201).json(q.rows[0]);}catch(e){res.status(e.status||400).json({error:e.message});}});
router.get('/:schoolId/class-teachers',schoolBoundary,async(req,res)=>{try{res.json((await db.query(`SELECT * FROM (SELECT DISTINCT ON (a.class_id,a.academic_year_id) a.*,t.staff_no,t.first_name teacher_first_name,t.last_name teacher_last_name,c.name class_name,c.stream,lv.name level_name,ay.year_label,tm.name term_name FROM class_teacher_assignments a JOIN teachers t ON t.id=a.teacher_id JOIN classes c ON c.id=a.class_id JOIN school_levels lv ON lv.id=c.school_level_id JOIN academic_years ay ON ay.id=a.academic_year_id LEFT JOIN terms tm ON tm.id=a.term_id WHERE a.school_id=$1 ORDER BY a.class_id,a.academic_year_id,a.created_at DESC,a.id DESC) z ORDER BY year_label DESC,class_name,teacher_last_name`,[req.params.schoolId])).rows)}catch(e){res.status(500).json({error:'Unable to load class teachers'});}});
router.post('/:schoolId/class-teachers',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{const b=req.body||{},sid=req.params.schoolId,c=await db.pool.connect();try{if(!b.teacher_id||!b.class_id||!b.academic_year_id)return res.status(400).json({error:'Teacher, class and academic year are required.'});await assertBelongs('teachers',b.teacher_id,sid);await assertBelongs('classes',b.class_id,sid);await assertBelongs('academic_years',b.academic_year_id,sid);if(b.term_id)await assertBelongs('terms',b.term_id,sid);await c.query('BEGIN');const t=(await c.query(`SELECT id,user_id,is_active FROM teachers WHERE id=$1 AND school_id=$2`,[b.teacher_id,sid])).rows[0];if(!t?.is_active)throw Object.assign(new Error('The selected teacher is inactive.'),{status:400});if(!t.user_id)throw Object.assign(new Error('The selected teacher must have a linked PRO-MARK login before becoming a Class Teacher.'),{status:400});
// A Class Teacher is one school role, not a second parallel role. Existing subject assignments remain intact.
await c.query(`DELETE FROM user_school_roles WHERE user_id=$1 AND school_id=$2`,[t.user_id,sid]);
await c.query(`INSERT INTO user_school_roles(user_id,school_id,role,mark_entry_enabled) VALUES($1,$2,'CLASS_TEACHER',true)`,[t.user_id,sid]);
// Exactly one Class Teacher per class/year/term. Reassigning replaces the previous one.
await c.query(`DELETE FROM class_teacher_assignments WHERE school_id=$1 AND class_id=$2 AND academic_year_id=$3`,[sid,b.class_id,b.academic_year_id]);
const q=await c.query(`INSERT INTO class_teacher_assignments(school_id,teacher_id,class_id,academic_year_id,term_id) VALUES($1,$2,$3,$4,$5) RETURNING *`,[sid,b.teacher_id,b.class_id,b.academic_year_id,b.term_id||null]);
// A Class Teacher remains a single school role; the teacher's subject assignments are not deleted.
await c.query('COMMIT');res.status(201).json(q.rows[0]);}catch(e){try{await c.query('ROLLBACK')}catch{}res.status(e.status||400).json({error:e.message});}finally{c.release();}});

router.get('/:schoolId/my-class-teacher-assignments',schoolBoundary,roles('CLASS_TEACHER','TEACHER','SENIOR_TEACHER'),async(req,res)=>{try{
 const q=await db.query(`SELECT * FROM (SELECT DISTINCT ON (a.class_id,a.academic_year_id) a.id,a.teacher_id,a.class_id,a.academic_year_id,a.term_id,c.name class_name,c.stream,lv.name level_name,ay.year_label,tm.name term_name FROM class_teacher_assignments a JOIN teachers t ON t.id=a.teacher_id JOIN classes c ON c.id=a.class_id JOIN school_levels lv ON lv.id=c.school_level_id JOIN academic_years ay ON ay.id=a.academic_year_id LEFT JOIN terms tm ON tm.id=a.term_id WHERE a.school_id=$1 AND t.user_id=$2 ORDER BY a.class_id,a.academic_year_id,a.created_at DESC,a.id DESC) z ORDER BY year_label DESC,class_name`,[req.params.schoolId,req.user.user_id]);res.json(q.rows);
}catch(e){res.status(e.status||400).json({error:e.message});}});

router.get('/:schoolId/teacher-assignments/:teacherId',schoolBoundary,async(req,res)=>{
  try{
    await assertBelongs('teachers',req.params.teacherId,req.params.schoolId);
    const q=await db.query(`
      SELECT a.id,a.school_id,a.teacher_id,a.subject_id,a.class_id,a.academic_year_id,
             a.term_id,
             s.code subject_code,s.name subject_name,c.name class_name,c.stream,
             lv.name level_name,ay.year_label,tm.name AS term_name
      FROM teacher_subject_assignments a
      JOIN subjects s ON s.id=a.subject_id
      JOIN classes c ON c.id=a.class_id
      JOIN school_levels lv ON lv.id=c.school_level_id
      JOIN academic_years ay ON ay.id=a.academic_year_id LEFT JOIN terms tm ON tm.id=a.term_id
      WHERE a.school_id=$1 AND a.teacher_id=$2
      ORDER BY ay.year_label DESC,c.name,s.name`,
      [req.params.schoolId,req.params.teacherId]
    );
    res.json(q.rows);
  }catch(e){res.status(e.status||400).json({error:e.message});}
});

router.get('/:schoolId/classes/:classId/pdf',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'),async(req,res)=>{try{
 const sid=req.params.schoolId,cid=req.params.classId;await assertBelongs('classes',cid,sid);
 const c=(await db.query(`SELECT c.name,c.stream,lv.name level_name,sc.name school_name,si.motto,si.address,si.contact_phone,si.contact_email,si.primary_color,si.secondary_color,si.logo_url
   FROM classes c JOIN school_levels lv ON lv.id=c.school_level_id JOIN schools sc ON sc.id=c.school_id
   LEFT JOIN school_identity si ON si.school_id=c.school_id WHERE c.id=$1 AND c.school_id=$2`,[cid,sid])).rows[0];
 if(!c)return res.status(404).json({error:'Class not found'});
 if(req.user.role==='CLASS_TEACHER'){
   const ok=(await db.query(`SELECT 1 FROM class_teacher_assignments a JOIN teachers t ON t.id=a.teacher_id
     WHERE a.school_id=$1 AND a.class_id=$2 AND t.user_id=$3 LIMIT 1`,[sid,cid,req.user.user_id])).rows[0];
   if(!ok)return res.status(403).json({error:'You can only print a class list for a class assigned to you.'});
 }
 const rows=(await db.query(`SELECT l.admission_no,l.assessment_no,l.first_name,l.middle_name,l.last_name,l.gender,COALESCE(l.status,'ACTIVE') status
   FROM learners l WHERE l.school_id=$1 AND l.class_id=$2 ORDER BY lower(trim(coalesce(l.first_name,'') || ' ' || coalesce(l.middle_name,'') || ' ' || coalesce(l.last_name,''))), l.id`,[sid,cid])).rows;
 const PDFDocument=require('pdfkit');
 const doc=new PDFDocument({size:'A4',layout:'landscape',margin:28,autoFirstPage:false});
 const firstPage={size:'A4',layout:'landscape',margin:28};
 doc.addPage(firstPage);
 const chunks=[];doc.on('data',chunk=>chunks.push(chunk));
 const pdfDone=new Promise((resolve,reject)=>{doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
 const W=doc.page.width-doc.page.margins.left-doc.page.margins.right,x=doc.page.margins.left,navy=c.primary_color||'#17365D',gold=c.secondary_color||'#B8860B',ink='#111827',line='#111111',logoPath=assetSource(c.logo_url);
 const stars=(xx,yy,ww,hh)=>{doc.save().strokeColor(gold).lineWidth(1.2).roundedRect(xx,yy,ww,hh,6).stroke();doc.font('Helvetica-Bold').fontSize(7).fillColor(gold);for(let sx=xx+6;sx<xx+ww-4;sx+=18){doc.text('★',sx,yy-1,{width:8});doc.text('★',sx,yy+hh-8,{width:8});}for(let sy=yy+13;sy<yy+hh-8;sy+=16){doc.text('★',xx-1,sy,{width:8});doc.text('★',xx+ww-4,sy,{width:8});}doc.restore();};
 stars(18,18,doc.page.width-36,doc.page.height-36);
 if(logoPath)try{doc.save().opacity(.045);doc.image(logoPath,x+W/2-120,doc.page.height/2-120,{fit:[240,240]});doc.restore();}catch{}
 const address=[c.address,c.contact_phone,c.contact_email].filter(Boolean).join('  |  ');
 if(address)doc.fillColor('#374151').font('Helvetica').fontSize(7.2).text(address,x,22,{width:W,align:'center'});
 if(logoPath)try{doc.image(logoPath,x+W/2-36,34,{fit:[72,72],align:'center',valign:'center'});}catch{}
 doc.fillColor(navy).font('Helvetica-Bold').fontSize(17).text(c.school_name||'SCHOOL',x,111,{width:W,align:'center'});
 doc.fontSize(8).fillColor('#374151').font('Helvetica').text(c.motto||'',x,133,{width:W,align:'center'});
 doc.fillColor(gold).lineWidth(1.3).moveTo(x,146).lineTo(x+W,146).stroke();
 doc.fillColor(navy).font('Helvetica-Bold').fontSize(12).text('CLASS LIST / LEARNER REGISTER',x,154,{width:W,align:'center'});
 doc.fillColor('#111827').font('Helvetica').fontSize(8).text(`${c.level_name||''} · ${c.name||''}${c.stream?' · '+c.stream:''}`,x,171,{width:W,align:'center'});
 let y=190;
 // Working/reference columns are intentionally blank so the downloaded/printed register
 // can be used for attendance, continuous records, parent references and teacher notes.
 const rawWidths=[28,72,72,185,45,55,62,62,62,72,90];
 const widthScale=W/rawWidths.reduce((a,b)=>a+b,0);
 const widths=rawWidths.map(v=>v*widthScale);
 const heads=['#','ADM. NO.','ASSES. NO.','LEARNER NAME','SEX','STATUS','TERM 1','TERM 2','TERM 3','ATTENDANCE','REMARKS'];
 const header=()=>{
   doc.fillColor(navy).rect(x,y,W,24).fill();let xx=x;
   heads.forEach((h,i)=>{const wi=widths[i];doc.fillColor('#fff').font('Helvetica-Bold').fontSize(7).text(h,xx+3,y+8,{width:wi-6,align:i===0?'center':'left'});if(i<heads.length-1){doc.strokeColor('#fff').lineWidth(.7).moveTo(xx+wi,y).lineTo(xx+wi,y+24).stroke();}xx+=wi;});
   y+=24;
 };
 header();
 rows.forEach((r,i)=>{
   if(y>doc.page.height-48){doc.addPage(firstPage);y=28;header();}
   let xx=x;
   const vals=[String(i+1),r.admission_no||'',r.assessment_no||'',[r.first_name,r.middle_name,r.last_name].filter(Boolean).join(' '),r.gender||'',r.status||'ACTIVE','','','','',''];
   doc.font('Helvetica').fontSize(7.2);
   vals.forEach((v,j)=>{doc.fillColor(ink).text(String(v),xx+3,y+8,{width:widths[j]-6,align:j===0?'center':'left',height:16,lineBreak:false});doc.strokeColor(line).lineWidth(1).rect(xx,y,widths[j],22).stroke();xx+=widths[j];});
   y+=22;
 });
 doc.strokeColor(line).lineWidth(1).moveTo(x,doc.page.height-36).lineTo(x+W,doc.page.height-36).stroke();doc.fillColor('#374151').fontSize(6.8).text(`PRO-MARK • ${c.contact_email||'School contact email'} • Total learners: ${rows.length}`,x,doc.page.height-28,{width:W,align:'right'});
 doc.end();
 const pdf=await pdfDone;
 res.setHeader('Content-Type','application/pdf');
 res.setHeader('Content-Disposition',`inline; filename="class-list-${String(c.name||'class').replace(/[^a-z0-9]+/gi,'-').toLowerCase()}.pdf"`);
 res.end(pdf);
 }catch(e){console.error('Class list PDF failed:',e);if(!res.headersSent)res.status(e.status||400).json({error:e.message||'Unable to create class list PDF'});}});
module.exports=router;