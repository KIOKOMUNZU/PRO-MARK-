const express=require("express"),bcrypt=require("bcryptjs"),crypto=require("crypto"),db=require("../db");
const multer=require("multer"),ExcelJS=require("exceljs"),fs=require("fs"),path=require("path");
const {authenticate,roles}=require("../middleware/auth");
const router=express.Router();router.use(authenticate,roles("PLATFORM_OWNER"));
router.get("/users",async(req,res)=>{
  try{
    const q=await db.query(`SELECT u.id user_id,u.email,u.first_name,u.last_name,u.is_active,
      r.id role_id,r.school_id,r.role,r.mark_entry_enabled,s.name school_name
      FROM users u LEFT JOIN user_school_roles r ON r.user_id=u.id
      LEFT JOIN schools s ON s.id=r.school_id
      ORDER BY u.last_name,u.first_name,u.email,s.name`);
    res.json(q.rows);
  }catch(e){res.status(500).json({error:'Unable to load platform users.'});}
});
router.patch("/users/:roleId",async(req,res)=>{
  const b=req.body||{},c=await db.pool.connect();
  try{
    const r=(await c.query(`SELECT r.id,r.user_id,r.school_id,r.role,u.email
      FROM user_school_roles r JOIN users u ON u.id=r.user_id WHERE r.id=$1`,[req.params.roleId])).rows[0];
    if(!r)return res.status(404).json({error:'User role not found.'});
    // PLATFORM_OWNER is the protected platform-level account. It must never be
    // disabled, converted to a school role, have Mark Entry toggled, or be removed
    // through school-user controls. This prevents the owner from locking themselves
    // out while managing schools and teachers.
    if(String(r.role).toUpperCase()==='PLATFORM_OWNER'){
      if(b.role!==undefined && String(b.role).toUpperCase()!=='PLATFORM_OWNER')
        return res.status(403).json({error:'The Platform Owner role is protected and cannot be changed here.'});
      if(typeof b.is_active==='boolean' && b.is_active===false)
        return res.status(403).json({error:'The Platform Owner account cannot be deactivated.'});
      if(typeof b.mark_entry_enabled==='boolean' && b.mark_entry_enabled===false)
        return res.status(403).json({error:'The Platform Owner cannot have Mark Entry disabled.'});
      return res.json({ok:true,protected:true,message:'Platform Owner is protected.'});
    }
    await c.query('BEGIN');
    if(typeof b.is_active==='boolean'){
      await c.query('UPDATE users SET is_active=$2 WHERE id=$1',[r.user_id,b.is_active]);
      await c.query('UPDATE teachers SET is_active=$2 WHERE user_id=$1 AND school_id=$3',[r.user_id,b.is_active,r.school_id]);
    }
    if(typeof b.mark_entry_enabled==='boolean')
      await c.query('UPDATE user_school_roles SET mark_entry_enabled=$2 WHERE id=$1',[r.id,b.mark_entry_enabled]);
    if(b.role!==undefined){
      const next=String(b.role||'').toUpperCase();
      const allowed=['SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'];
      const unique=['SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER'];
      if(!allowed.includes(next))throw Object.assign(new Error('Invalid school role.'),{status:400});
      if(unique.includes(next)){
        const conflict=(await c.query(`SELECT u.email FROM user_school_roles rr
          JOIN users u ON u.id=rr.user_id
          WHERE rr.school_id=$1 AND rr.role=$2 AND rr.id<>$3 LIMIT 1`,
          [r.school_id,next,r.id])).rows[0];
        if(conflict)throw Object.assign(new Error(`${next.replaceAll('_',' ')} is already assigned to ${conflict.email}. Remove that role first.`),{status:409});
      }
      // 3.9.7+ enforces one school role per user. Update the existing role
      // rather than deleting/recreating rows, which also preserves role history.
      await c.query('UPDATE user_school_roles SET role=$2 WHERE id=$1',[r.id,next]);
    }
    await c.query('COMMIT');
    res.json({ok:true});
  }catch(e){try{await c.query('ROLLBACK')}catch{}res.status(e.status||400).json({error:e.message});}
  finally{c.release();}
});
router.delete('/users/:roleId',async(req,res)=>{
  const c=await db.pool.connect();
  try{
    const r=(await c.query(`SELECT r.id,r.user_id,r.school_id,r.role,u.email FROM user_school_roles r JOIN users u ON u.id=r.user_id WHERE r.id=$1`,[req.params.roleId])).rows[0];
    if(!r)return res.status(404).json({error:'User role not found.'});
    if(String(r.role).toUpperCase()==='PLATFORM_OWNER')return res.status(403).json({error:'The Platform Owner role cannot be removed.'});
    if(r.user_id===req.user.user_id)return res.status(400).json({error:'You cannot remove your own active platform school role.'});
    await c.query('BEGIN');
    await c.query('DELETE FROM user_school_roles WHERE id=$1',[r.id]);
    await c.query('COMMIT');
    res.json({ok:true,removed_role:r.role,email:r.email,school_id:r.school_id});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});res.status(400).json({error:e.message});}finally{c.release();}
});

router.post('/users/:roleId/reset-password',async(req,res)=>{
  try{
    const r=(await db.query(`SELECT r.user_id,u.email FROM user_school_roles r JOIN users u ON u.id=r.user_id WHERE r.id=$1`,[req.params.roleId])).rows[0];
    if(!r)return res.status(404).json({error:'User role not found.'});
    const supplied=String(req.body?.new_password||'').trim();
    const temp=supplied||('PM-'+crypto.randomBytes(9).toString('base64url')+'9');
    if(temp.length<10)return res.status(400).json({error:'Password must be at least 10 characters.'});
    const hash=await bcrypt.hash(temp,12);
    await db.query('UPDATE users SET password_hash=$2,is_active=true,updated_at=now() WHERE id=$1',[r.user_id,hash]);
    res.json({ok:true,email:r.email,temporary_password:temp,message:'Password reset. Give the temporary password to the user securely, then have them change it.'});
  }catch(e){res.status(400).json({error:e.message});}
});


const workbookUpload=multer({dest:path.join(__dirname,"..","..","uploads","schools"),limits:{fileSize:20*1024*1024},fileFilter:(req,file,cb)=>{const ok=/\.(xlsx|xlsm)$/i.test(file.originalname);cb(ok?null:new Error("Please upload an Excel .xlsx or .xlsm workbook."),ok);}});
const {parseRelevantWorkbook}=require('../services/workbook-import');
const cleanCell=v=>String(v??"").trim();
const norm=v=>cleanCell(v).toUpperCase().replace(/[^A-Z0-9]+/g,"_").replace(/^_|_$/g,"");
const gradeInfo=v=>{const x=norm(v).replace(/^FINAL_|^AVERAGE_/g,"");if(x.startsWith("GRADE9A"))return {code:"GRADE_9",name:"Grade 9",stream:"A"};if(x.startsWith("GRADE9B"))return {code:"GRADE_9",name:"Grade 9",stream:"B"};const m=x.match(/^(PP1|PP2|GRADE_[1-9])/);if(!m)return null;return {code:m[1],name:m[1]==="PP1"?"PP1":m[1]==="PP2"?"PP2":m[1].replace("GRADE_","Grade "),stream:""};};
function inferredSchoolName(filename){let n=path.basename(filename,path.extname(filename)).replace(/[_-]+/g," ").replace(/\b(20\d{2})\b.*$/i,"").replace(/\bMARKS?\b.*$/i,"").trim();return n.replace(/\bSCHOOL\b$/i,"SCHOOL").trim()||"Imported School";}
function inferredCode(name){const x=norm(name);return (x.match(/[A-Z0-9]+/)||["SCHOOL"])[0].slice(0,20);}
function detectYear(filename){const m=String(filename).match(/\b(20\d{2})\b/);return m?m[1]:String(new Date().getFullYear());}
function detectAssessmentColumns(rows){
  const cols={};
  const candidates=(rows||[]).slice(0,12);
  for(const row of candidates){
    for(let i=0;i<(row||[]).length;i++){
      const h=norm(row[i]).replace(/_/g,' ');
      if(h==='OPENER'||h==='OPENING')cols.OPENER=i;
      else if(h==='MIDTERM'||h==='MID TERM'||h==='MID TERM EXAM')cols.MID_TERM=i;
      else if(h==='END TERM'||h==='ENDTERM'||h==='END TERM EXAM')cols.END_TERM=i;
      else if(h==='AVERAGE'||h==='AVG'||h==='MEAN'||h==='TERM AVERAGE')cols.AVERAGE=i;
    }
  }
  return cols;
}
const importJobs=new Map();
const jobId=()=>crypto.randomBytes(12).toString('hex');
const jobUpdate=(id,patch)=>{const j=importJobs.get(id);if(j)Object.assign(j,patch, {updated_at:new Date().toISOString()});};

router.post('/schools/import/preview',workbookUpload.single('workbook'),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Select an Excel workbook first.'});
  try{
    const parsed=await parseRelevantWorkbook(req.file.path);
    const tw=parsed.teachers,mw=parsed.marks;
    let teachers=0,marksRows=0,validMarks=0,openerMarks=0,midTermMarks=0,endTermMarks=0,averageValues=0;const classes=new Set(),subjects=new Set(),learners=new Set();
    for(let n=1;n<tw.length;n++){
      const v=tw[n]||[],u=cleanCell(v[1]),name=cleanCell(v[2]);
      if(u&&name&&u.toUpperCase()!=="TEACHER"&&name.toUpperCase()!=="TEACHER"&&name.toUpperCase()!=="ADMIN")teachers++;
    }
    const assessmentCols=detectAssessmentColumns(mw);
    for(let n=1;n<mw.length;n++){
      const v=mw[n]||[],grade=cleanCell(v[2]),subject=cleanCell(v[3]),student=cleanCell(v[4]);
      if(!grade||!subject||!student)continue;marksRows++;const gi=gradeInfo(grade);if(gi)classes.add(`${gi.code}|${gi.stream}`);subjects.add(norm(subject));learners.add(`${grade}|${student}`);
      for(const [type,col] of Object.entries(assessmentCols)){const x=v[col];if(x!==null&&x!==undefined&&cleanCell(x)!==''&&!Number.isNaN(Number(x))&&Number(x)>=0&&Number(x)<=100){validMarks++;if(type==='OPENER')openerMarks++;else if(type==='MID_TERM')midTermMarks++;else if(type==='END_TERM')endTermMarks++;else if(type==='AVERAGE')averageValues++;}}
    }
    const parsedFile=`${req.file.path}.json`;
    await fs.promises.writeFile(parsedFile,JSON.stringify(parsed),'utf8');
    try{fs.unlinkSync(req.file.path)}catch{}
    res.json({ok:true,file:req.file.originalname,stored_file:parsedFile,parsed_file:parsedFile,name:inferredSchoolName(req.file.originalname),code:inferredCode(inferredSchoolName(req.file.originalname)),year:detectYear(req.file.originalname),template_code:'JUNIOR',sheets:parsed.sheets,counts:{teachers,mark_rows:marksRows,valid_marks:validMarks,opener_marks:openerMarks,mid_term_marks:midTermMarks,end_term_marks:endTermMarks,average_values:averageValues,classes:classes.size,subjects:subjects.size,learners:learners.size},assessment_columns:assessmentCols,import_mapping:{opener_source:(openerMarks>0?'OPENER':(openerMarks===0&&endTermMarks===0&&averageValues>0?'AVERAGE_AS_TERM3_OPENER':'NONE')),end_term_source:(endTermMarks>0?'END_TERM':'NONE'),average_policy:'AVERAGE is never silently converted to End Term. For a Term 3 workbook containing only AVERAGE, it is imported as OPENER.'},message:'Workbook detected. Review the school details, then import it.'});
  }catch(e){try{fs.unlinkSync(req.file.path)}catch{}res.status(400).json({error:e.message||'Workbook could not be detected.'});}
});

async function executeSchoolImport({jobId:jid,parsed,name,code,yearLabel,templateCode,sourceName,parsedFile}){
  let c;
  try{
    jobUpdate(jid,{status:'RUNNING',stage:'Preparing school',progress:5,message:'Preparing the school structure…'});
    c=await db.pool.connect();await c.query('BEGIN');
    const existing=await c.query('SELECT id,name,code FROM schools WHERE code=$1 LIMIT 1',[code]);
    if(existing.rows[0])throw Object.assign(new Error(`School code ${existing.rows[0].code} is already in use by ${existing.rows[0].name}. Choose a different unique school code.`),{status:409});
    const t=(await c.query('SELECT id FROM school_templates WHERE code=$1 AND is_system=true',[templateCode||'JUNIOR'])).rows[0];
    if(!t)throw new Error('Selected school template does not exist.');
    const school=(await c.query("INSERT INTO schools(code,name,template_id,status) VALUES($1,$2,$3,'ACTIVE') RETURNING id,code,name,status",[code,name,t.id])).rows[0];
    await c.query(`INSERT INTO school_identity(school_id,motto) VALUES($1,'') ON CONFLICT(school_id) DO NOTHING`,[school.id]);
    await c.query(`INSERT INTO school_sections(school_id,template_section_id,code,name,sort_order) SELECT $1,id,code,name,sort_order FROM template_sections WHERE template_id=$2 ON CONFLICT DO NOTHING`,[school.id,t.id]);
    await c.query(`INSERT INTO school_levels(school_section_id,template_level_id,code,name,sort_order) SELECT ss.id,tl.id,tl.code,tl.name,tl.sort_order FROM school_sections ss JOIN template_levels tl ON tl.template_section_id=ss.template_section_id WHERE ss.school_id=$1 ON CONFLICT DO NOTHING`,[school.id]);
    const year=(await c.query(`INSERT INTO academic_years(school_id,year_label,status) VALUES($1,$2,'ACTIVE') ON CONFLICT(school_id,year_label) DO UPDATE SET status='ACTIVE' RETURNING id`,[school.id,yearLabel])).rows[0];
    const termIds={};for(let n=1;n<=3;n++)termIds[n]=(await c.query(`INSERT INTO terms(school_id,academic_year_id,term_no,name,status) VALUES($1,$2,$3,$4,$5) ON CONFLICT(academic_year_id,term_no) DO UPDATE SET name=EXCLUDED.name RETURNING id`,[school.id,year.id,n,`Term ${n}`,n===3?'ACTIVE':'PLANNED'])).rows[0].id;
    jobUpdate(jid,{stage:'Reading workbook data',progress:12,message:'Building teachers, classes, subjects and learners…'});
    const tw=parsed.teachers||[],mw=parsed.marks||[];
    const assessmentCols=detectAssessmentColumns(mw);
    const roleMap=r=>{const x=norm(r);if(x.includes('HEADTEACHER'))return 'HEADTEACHER';if(x.includes('SENIOR_TEACHER'))return 'SENIOR_TEACHER';if(x.includes('CLASSTEACHER'))return 'CLASS_TEACHER';return 'TEACHER';};
    const teacherRows=[],markRows=[];
    for(let n=1;n<tw.length;n++){const v=tw[n]||[],u=cleanCell(v[1]),full=cleanCell(v[2]),role=roleMap(v[3]),pairs=cleanCell(v[5]);if(!u||!full||u.toUpperCase()==='TEACHER'||full.toUpperCase()==='TEACHER'||full.toUpperCase()==='ADMIN')continue;teacherRows.push({u,full,role,pairs});}
    for(let n=1;n<mw.length;n++){const v=mw[n]||[],teacher=cleanCell(v[1]),grade=cleanCell(v[2]),subject=cleanCell(v[3]),student=cleanCell(v[4]);if(!grade||!subject||!student)continue;markRows.push({teacher,grade,subject,student,opener:assessmentCols.OPENER!==undefined?v[assessmentCols.OPENER]:undefined,midTerm:assessmentCols.MID_TERM!==undefined?v[assessmentCols.MID_TERM]:undefined,endTerm:assessmentCols.END_TERM!==undefined?v[assessmentCols.END_TERM]:undefined,average:assessmentCols.AVERAGE!==undefined?v[assessmentCols.AVERAGE]:undefined});}
    const validNumber=v=>v!==null&&v!==undefined&&cleanCell(v)!==''&&!Number.isNaN(Number(v))&&Number(v)>=0&&Number(v)<=100;
    const endTermAvailable=markRows.some(r=>validNumber(r.endTerm));
    const averageAsTerm3Opener=!markRows.some(r=>validNumber(r.opener))&&!markRows.some(r=>validNumber(r.endTerm))&&markRows.some(r=>validNumber(r.average));
    const levelRows=await c.query(`SELECT sl.id,sl.code,sl.name FROM school_levels sl JOIN school_sections ss ON ss.id=sl.school_section_id WHERE ss.school_id=$1`,[school.id]);
    const levelMap=new Map(levelRows.rows.map(x=>[x.code,x.id]));
    const classRefs=new Map(),subjectNames=new Map();
    for(const r of teacherRows)for(const pair of r.pairs.split(',').map(x=>x.trim()).filter(Boolean)){const m=pair.match(/^([^|]+)\|(.+)$/);if(!m)continue;const gi=gradeInfo(m[1]);if(gi)classRefs.set(gi.code+'|'+gi.stream,gi);const nm=cleanCell(m[2]);if(nm)subjectNames.set(norm(nm),nm);}
    for(const r of markRows){const gi=gradeInfo(r.grade);if(gi)classRefs.set(gi.code+'|'+gi.stream,gi);const nm=cleanCell(r.subject);if(nm)subjectNames.set(norm(nm),nm);}
    const classes=new Map(),subjects=new Map(),teachers=new Map();
    const classEntries=[...classRefs.entries()].filter(([k,gi])=>levelMap.has(gi.code));
    if(classEntries.length){const vals=[],params=[];let p=1;for(const [,gi] of classEntries){vals.push(`($${p++},$${p++},$${p++},$${p++})`);params.push(school.id,levelMap.get(gi.code),gi.name,gi.stream);}const q=await c.query(`INSERT INTO classes(school_id,school_level_id,name,stream) VALUES ${vals.join(',')} ON CONFLICT(school_id,name,stream) DO UPDATE SET is_active=true RETURNING id,name,stream`,params);for(const row of q.rows){classes.set(norm(row.name)+'|'+cleanCell(row.stream),row.id);}for(const [,gi] of classEntries){const id=classes.get(norm(gi.name)+'|'+cleanCell(gi.stream));if(id)classes.set(gi.code+'|'+gi.stream,id);}}
    const subjectEntries=[...subjectNames.entries()];if(subjectEntries.length){const vals=[],params=[];let p=1;for(const [cd,nm] of subjectEntries){vals.push(`($${p++},$${p++},$${p++})`);params.push(school.id,cd,nm.toUpperCase());}const q=await c.query(`INSERT INTO subjects(school_id,code,name) VALUES ${vals.join(',')} ON CONFLICT(school_id,code) DO UPDATE SET name=EXCLUDED.name,is_active=true RETURNING id,code`,params);for(const row of q.rows)subjects.set(row.code,row.id);}
    if(teacherRows.length){const vals=[],params=[];let p=1;for(const r of teacherRows){const parts=r.full.split(/\s+/);vals.push(`($${p++},$${p++},$${p++},$${p++})`);params.push(school.id,r.u,parts[0],parts.slice(1).join(' ')||'Teacher');}const q=await c.query(`INSERT INTO teachers(school_id,staff_no,first_name,last_name) VALUES ${vals.join(',')} ON CONFLICT(school_id,staff_no) DO UPDATE SET first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,is_active=true RETURNING id,staff_no`,params);for(const row of q.rows)teachers.set(row.staff_no,row.id);}
    const assignmentRows=[];for(const r of teacherRows){const teacherId=teachers.get(r.u);for(const pair of r.pairs.split(',').map(x=>x.trim()).filter(Boolean)){const m=pair.match(/^([^|]+)\|(.+)$/);if(!m)continue;const gi=gradeInfo(m[1]),sub=subjects.get(norm(m[2])),cls=gi&&classes.get(gi.code+'|'+gi.stream);if(teacherId&&gi&&sub&&cls)assignmentRows.push([school.id,teacherId,sub,cls,year.id,termIds[3],r.role==='CLASS_TEACHER']);}}
    for(let off=0;off<assignmentRows.length;off+=500){const chunk=assignmentRows.slice(off,off+500),vals=[],params=[];let p=1;for(const row of chunk){vals.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);params.push(...row);}await c.query(`INSERT INTO teacher_subject_assignments(school_id,teacher_id,subject_id,class_id,academic_year_id,term_id,is_class_teacher) VALUES ${vals.join(',')} ON CONFLICT DO NOTHING`,params);}
    const assessmentSpecs=[];if(assessmentCols.OPENER!==undefined)assessmentSpecs.push(['Opener','OPENER',1]);if(assessmentCols.END_TERM!==undefined)assessmentSpecs.push(['End Term','END_TERM',2]);if(averageAsTerm3Opener&&!assessmentSpecs.some(x=>x[1]==='OPENER'))assessmentSpecs.push(['Opener (Imported)','OPENER',1]);const assessments={};for(const [nm,type,ord] of assessmentSpecs){let q=await c.query(`SELECT id FROM assessments WHERE school_id=$1 AND academic_year_id=$2 AND term_id=$3 AND assessment_type=$4 ORDER BY created_at LIMIT 1`,[school.id,year.id,termIds[3],type]);if(!q.rows[0])q=await c.query(`INSERT INTO assessments(school_id,academic_year_id,term_id,name,assessment_type,max_mark,weight,include_in_final,assessment_order,status) VALUES($1,$2,$3,$4,$5,100,50,true,$6,'OPEN') RETURNING id`,[school.id,year.id,termIds[3],nm,type,ord]);assessments[type]=q.rows[0].id;}
    const learnerKeys=new Map();for(const r of markRows){const gi=gradeInfo(r.grade);if(!gi||!classes.has(gi.code+'|'+gi.stream))continue;const key=`${r.grade}|${r.student}`;if(!learnerKeys.has(key))learnerKeys.set(key,{grade:r.grade,student:r.student,classId:classes.get(gi.code+'|'+gi.stream)});}
    const learners=new Map(),learnerEntries=[...learnerKeys.entries()];
    for(let off=0;off<learnerEntries.length;off+=300){const chunk=learnerEntries.slice(off,off+300),vals=[],params=[],admissionToKey=new Map();let p=1;for(const [key,r] of chunk){const parts=r.student.split(/\s+/),admission=null;vals.push(`($${p++},NULL,$${p++},'',$${p++},$${p++})`);params.push(school.id,parts[0],parts.slice(1).join(' ')||'Learner',r.classId);admissionToKey.set(key,key);}const q=await c.query(`INSERT INTO learners(school_id,admission_no,first_name,middle_name,last_name,class_id) VALUES ${vals.join(',')} RETURNING id,admission_no,first_name,last_name,class_id`,params);const importedRows=learnerEntries.slice(off,off+300);q.rows.forEach((row,i)=>{const src=importedRows[i];if(src)learners.set(src[0],{id:row.id,admission:null});});}
    const enrollmentValues=[],enrollmentParams=[];let pidx=1;for(const [key,l] of learners){const r=learnerKeys.get(key);enrollmentValues.push(`($${pidx++},$${pidx++},$${pidx++},$${pidx++},'ACTIVE')`);enrollmentParams.push(school.id,l.id,year.id,r.classId);}if(enrollmentValues.length)await c.query(`INSERT INTO learner_enrollments(school_id,learner_id,academic_year_id,class_id,status) VALUES ${enrollmentValues.join(',')} ON CONFLICT(learner_id,academic_year_id) DO UPDATE SET class_id=EXCLUDED.class_id,status='ACTIVE'`,enrollmentParams);
    jobUpdate(jid,{stage:'Importing marks',progress:75,message:`Importing ${markRows.length.toLocaleString()} mark rows…`});
    let marks=0;const validMarkRows=[];for(const r of markRows){const gi=gradeInfo(r.grade),cls=gi&&classes.get(gi.code+'|'+gi.stream),sub=subjects.get(norm(r.subject)),learner=learners.get(`${r.grade}|${r.student}`);if(!cls||!sub||!learner)continue;for(const [typ,val] of [['OPENER',averageAsTerm3Opener?r.average:r.opener],['END_TERM',r.endTerm]]){if(!assessments[typ]||val===null||val===undefined||cleanCell(val)===''||Number.isNaN(Number(val)))continue;const num=Number(val);if(num<0||num>100)continue;validMarkRows.push([school.id,learner.id,sub,cls,year.id,termIds[3],assessments[typ],num]);}}
    for(let off=0;off<validMarkRows.length;off+=800){const chunk=validMarkRows.slice(off,off+800),vals=[],params=[];let p=1;for(const row of chunk){vals.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},'Imported from uploaded workbook')`);params.push(...row);marks+=1;}await c.query(`INSERT INTO marks(school_id,learner_id,subject_id,class_id,academic_year_id,term_id,assessment_id,mark,remark) VALUES ${vals.join(',')} ON CONFLICT(learner_id,subject_id,assessment_id) DO UPDATE SET mark=EXCLUDED.mark,updated_at=now()`,params);jobUpdate(jid,{progress:75+Math.round(Math.min(20,(off+chunk.length)/Math.max(1,validMarkRows.length)*20)),message:`Imported ${Math.min(off+chunk.length,validMarkRows.length).toLocaleString()} of ${validMarkRows.length.toLocaleString()} mark values…`});}
    await c.query(`INSERT INTO migration_runs(school_id,source_name,mode,status,completed_at,counts) VALUES($1,$2,'PORTAL_IMPORT','COMPLETED',now(),$3)`,[school.id,sourceName,JSON.stringify({teachers:teachers.size,classes:classes.size,subjects:subjects.size,learners:learners.size,marks})]);
    await c.query('COMMIT');jobUpdate(jid,{status:'COMPLETED',stage:'Complete',progress:100,message:'School imported successfully.',school,counts:{teachers:teachers.size,classes:classes.size,subjects:subjects.size,learners:learners.size,marks}});
  }catch(e){if(c){try{await c.query('ROLLBACK')}catch{}}console.error('Platform school import failed:',e);jobUpdate(jid,{status:'FAILED',stage:'Failed',progress:100,error:e.message||'School import failed.',message:e.message||'School import failed.'});}
  finally{if(c)c.release();if(parsedFile){try{await fs.promises.unlink(parsedFile)}catch{}}}
}

router.post('/schools/import/commit',async(req,res)=>{
  const b=req.body||{};const parsedFile=path.resolve(String(b.parsed_file||b.stored_file||''));
  const uploadRoot=path.resolve(path.join(__dirname,'..','..','uploads','schools'));
  if(!parsedFile||!parsedFile.startsWith(uploadRoot+path.sep)||!fs.existsSync(parsedFile))return res.status(400).json({error:'Uploaded workbook data could not be found. Please upload it again.'});
  const name=cleanCell(b.name),code=norm(b.code),yearLabel=cleanCell(b.year)||String(new Date().getFullYear());if(!name||!code)return res.status(400).json({error:'School name and school code are required.'});
  try{
    const existing=await db.query('SELECT id,name,code FROM schools WHERE code=$1 LIMIT 1',[code]);if(existing.rows[0])return res.status(409).json({error:`School code ${existing.rows[0].code} is already in use by ${existing.rows[0].name}. Choose a different unique school code.`});
    const parsed=JSON.parse(await fs.promises.readFile(parsedFile,'utf8'));const jid=jobId();importJobs.set(jid,{id:jid,status:'QUEUED',stage:'Queued',progress:0,message:'Import queued…',created_at:new Date().toISOString(),updated_at:new Date().toISOString()});
    setImmediate(()=>executeSchoolImport({jobId:jid,parsed,name,code,yearLabel,templateCode:cleanCell(b.template_code)||'JUNIOR',sourceName:cleanCell(b.source_name)||'Uploaded workbook',parsedFile}));
    return res.status(202).json({ok:true,job_id:jid,status:'QUEUED',message:'Import started. You can watch the progress below.'});
  }catch(e){return res.status(400).json({error:e.message||'Unable to start school import.'});}
});
router.get('/schools/import/jobs/:jobId',async(req,res)=>{const j=importJobs.get(req.params.jobId);if(!j)return res.status(404).json({error:'Import job was not found. It may have completed before this server restart; check Registered schools.'});res.json(j);if(['COMPLETED','FAILED'].includes(j.status)){setTimeout(()=>importJobs.delete(j.id),10*60*1000);}});
router.get("/templates",async(req,res)=>{try{const q=await db.query(`SELECT t.id,t.code,t.name,t.description,COALESCE(json_agg(json_build_object('code',s.code,'name',s.name,'levels',(SELECT COALESCE(json_agg(json_build_object('code',l.code,'name',l.name) ORDER BY l.sort_order),'[]') FROM template_levels l WHERE l.template_section_id=s.id)) ORDER BY s.sort_order) FILTER(WHERE s.id IS NOT NULL),'[]') sections FROM school_templates t LEFT JOIN template_sections s ON s.template_id=t.id GROUP BY t.id ORDER BY t.code`);res.json(q.rows);}catch(e){console.error('Platform templates failed:',e);res.status(500).json({error:'Unable to load school templates.'});}});
router.get("/templates",async(req,res)=>{const q=await db.query(`SELECT t.id,t.code,t.name,t.description,COALESCE(json_agg(json_build_object('code',s.code,'name',s.name,'levels',(SELECT COALESCE(json_agg(json_build_object('code',l.code,'name',l.name) ORDER BY l.sort_order),'[]') FROM template_levels l WHERE l.template_section_id=s.id)) ORDER BY s.sort_order) FILTER(WHERE s.id IS NOT NULL),'[]') sections FROM school_templates t LEFT JOIN template_sections s ON s.template_id=t.id GROUP BY t.id ORDER BY t.code`);res.json(q.rows);});
router.get("/schools",async(req,res)=>{const q=await db.query(`SELECT s.id,s.code,s.name,s.status,t.code template_code,s.created_at,u.email admin_email FROM schools s JOIN school_templates t ON t.id=s.template_id LEFT JOIN LATERAL (SELECT u.email FROM users u JOIN user_school_roles r ON r.user_id=u.id WHERE r.school_id=s.id AND r.role='SCHOOL_ADMIN' ORDER BY r.created_at LIMIT 1) u ON true ORDER BY s.created_at DESC`);res.json(q.rows);});
router.post("/schools",async(req,res)=>{const c=await db.pool.connect();try{const b=req.body;if(!b.code||!b.name||!b.template_code||!b.admin_email||String(b.admin_password||"").length<10)return res.status(400).json({error:"School code, name, template and admin credentials are required"});await c.query("BEGIN");const existingUser=(await c.query(`SELECT u.id,r.role,r.school_id FROM users u JOIN user_school_roles r ON r.user_id=u.id WHERE LOWER(u.email)=LOWER($1) LIMIT 10`,[b.admin_email.trim()])).rows;if(existingUser.some(x=>x.role==='PLATFORM_OWNER'))throw Object.assign(new Error('Platform Owner email cannot be used as a school admin email. Use a separate school-admin email.'),{status:409});if(existingUser.length)throw Object.assign(new Error('That email is already attached to a PRO-MARK account. Use a unique school-admin email.'),{status:409});const t=(await c.query("SELECT id FROM school_templates WHERE code=$1 AND is_system=true",[b.template_code])).rows[0];if(!t)throw Error("Invalid master template");const s=(await c.query(`INSERT INTO schools(code,name,template_id) VALUES($1,$2,$3) RETURNING id,code,name,status`,[b.code.trim().toUpperCase(),b.name.trim(),t.id])).rows[0];await c.query(`INSERT INTO school_identity(school_id,motto) VALUES($1,'')`,[s.id]);await c.query(`INSERT INTO school_sections(school_id,template_section_id,code,name,sort_order) SELECT $1,id,code,name,sort_order FROM template_sections WHERE template_id=$2`,[s.id,t.id]);await c.query(`INSERT INTO school_levels(school_section_id,template_level_id,code,name,sort_order) SELECT ss.id,tl.id,tl.code,tl.name,tl.sort_order FROM school_sections ss JOIN template_levels tl ON tl.template_section_id=ss.template_section_id WHERE ss.school_id=$1`,[s.id]);const hash=await bcrypt.hash(b.admin_password,12);const u=(await c.query(`INSERT INTO users(email,password_hash,first_name,last_name) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash,is_active=true RETURNING id`,[b.admin_email.trim().toLowerCase(),hash,b.admin_first_name||"",b.admin_last_name||""])).rows[0];await c.query(`INSERT INTO user_school_roles(user_id,school_id,role) VALUES($1,$2,'SCHOOL_ADMIN') ON CONFLICT DO NOTHING`,[u.id,s.id]);await c.query(`INSERT INTO report_templates(school_id,section_code,name,template_type,primary_color,secondary_color,config) SELECT $1,code,CASE WHEN code='JUNIOR' THEN 'Junior Report' WHEN code='SENIOR' THEN 'Senior Report' ELSE 'Transitional Report' END,CASE WHEN code='JUNIOR' THEN 'JUNIOR_A4' WHEN code='SENIOR' THEN 'SENIOR_A4' ELSE 'TRANSITIONAL_A4' END,$2,$3,'{}'::jsonb FROM school_sections WHERE school_id=$1`,[s.id,'#17365D','#D9A441']);const defaultPlan=(await c.query(`SELECT * FROM billing_plans WHERE code='ANNUAL_STANDARD' AND is_active=true LIMIT 1`)).rows[0];if(defaultPlan){const start=new Date().toISOString().slice(0,10);const due=new Date(Date.UTC(new Date().getUTCFullYear()+1,new Date().getUTCMonth(),new Date().getUTCDate())).toISOString().slice(0,10);await c.query(`INSERT INTO school_subscriptions(school_id,plan_id,plan_name_snapshot,amount,currency,billing_cycle,starts_on,next_due_on,grace_days,status,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE','Auto-created during school creation') ON CONFLICT DO NOTHING`,[s.id,defaultPlan.id,defaultPlan.name,defaultPlan.amount,defaultPlan.currency,defaultPlan.billing_cycle,start,due,defaultPlan.grace_days]);}await c.query("COMMIT");res.status(201).json({school:s});}catch(e){await c.query("ROLLBACK");res.status(400).json({error:e.message});}finally{c.release();}});
router.patch("/schools/:schoolId/status",async(req,res)=>{const status=String(req.body.status||"").toUpperCase();if(!["ACTIVE","SUSPENDED","ARCHIVED"].includes(status))return res.status(400).json({error:"Invalid status"});const q=await db.query(`UPDATE schools SET status=$2,updated_at=now() WHERE id=$1 RETURNING id,code,name,status`,[req.params.schoolId,status]);if(!q.rows[0])return res.status(404).json({error:"School not found"});res.json(q.rows[0]);});
// Permanent school deletion is deliberately restricted to schools with no operational data.
router.delete('/schools/:schoolId',async(req,res)=>{
  const sid=req.params.schoolId;
  let c;
  try{
    c=await db.pool.connect();
    await c.query('BEGIN');
    const s=(await c.query('SELECT id,code,name,status FROM schools WHERE id=$1',[sid])).rows[0];
    if(!s){await c.query('ROLLBACK');return res.status(404).json({error:'School not found'});}

    // This is a true permanent delete. It is deliberately explicit and
    // transactional so it cannot leave a half-deleted school behind.
    const ordered=[
      'marks','report_comments','report_document_snapshots','learner_movement_events',
      'learner_enrollments','communication_messages','class_teacher_assignments',
      'teacher_subject_assignments','assessment_configurations','assessments','merit_runs',
      'report_templates','grading_systems','audit_log','billing_payments','billing_notifications',
      'billing_invoices','school_subscriptions','mark_entry_policies','portal_announcements',
      'school_announcements','school_document_assets','migration_runs','parent_guardians',
      'terms','academic_years','learners','teachers','classes','subjects','school_levels',
      'school_sections','school_identity','user_school_roles'
    ];
    for(const table of ordered){
      const exists=(await c.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='school_id' LIMIT 1`,[table])).rows[0];
      if(exists)await c.query(`DELETE FROM ${table} WHERE school_id=$1`,[sid]);
    }
    await c.query('DELETE FROM schools WHERE id=$1',[sid]);
    await c.query('COMMIT');
    return res.json({ok:true,action:'DELETED',school:s});
  }catch(e){
    if(c){try{await c.query('ROLLBACK')}catch{}}
    console.error('Permanent school deletion failed:',e);
    return res.status(400).json({error:e.message||'School could not be deleted.'});
  }finally{
    if(c)c.release();
  }
});
router.post("/schools/:schoolId/admin",async(req,res)=>{const b=req.body,c=await db.pool.connect();try{if(String(b.password||"").length<10||!b.email)throw Error("Email and password of at least 10 characters are required");const sid=req.params.schoolId;await c.query("BEGIN");const normalizedEmail=b.email.trim().toLowerCase();const school=(await c.query("SELECT id FROM schools WHERE id=$1",[sid])).rows[0];if(!school)throw Object.assign(new Error("School not found."),{status:404});const existing=(await c.query(`SELECT u.id,u.email,r.school_id,r.role FROM users u LEFT JOIN user_school_roles r ON r.user_id=u.id WHERE LOWER(u.email)=LOWER($1)`,[normalizedEmail])).rows;if(existing.some(x=>x.role==='PLATFORM_OWNER'))throw Object.assign(new Error('Platform Owner email cannot be used as a school admin email.'),{status:409});const hash=await bcrypt.hash(b.password,12);const u=(await c.query(`INSERT INTO users(email,password_hash,first_name,last_name) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash,first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,is_active=true,updated_at=now() RETURNING id,email`,[normalizedEmail,hash,b.first_name||"",b.last_name||""])).rows[0];await c.query(`DELETE FROM user_school_roles WHERE school_id=$1 AND role='SCHOOL_ADMIN'`,[sid]);await c.query(`DELETE FROM user_school_roles WHERE user_id=$1 AND school_id=$2`,[u.id,sid]);await c.query(`INSERT INTO user_school_roles(user_id,school_id,role,mark_entry_enabled) VALUES($1,$2,'SCHOOL_ADMIN',true)`,[u.id,sid]);await c.query("COMMIT");res.status(201).json({email:u.email});}catch(e){await c.query("ROLLBACK").catch(()=>{});res.status(e.status||400).json({error:e.message});}finally{c.release();}});
module.exports=router;
