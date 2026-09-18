const express=require("express"),db=require("../db");
const {authenticate,schoolBoundary,roles}=require("../middleware/auth");
const {buildTermReport,buildYearReport}=require("../services/report-engine");
const {reportPdf,reportPdfs}=require("../services/report-pdf");
const router=express.Router();router.use(authenticate);
async function enforceClassTeacherLearner(req,learnerId,yearId){
 if(req.user.role!=='CLASS_TEACHER')return;
 const ok=(await db.query(`SELECT 1 FROM learners l JOIN class_teacher_assignments a ON a.class_id=l.class_id AND a.school_id=l.school_id JOIN teachers t ON t.id=a.teacher_id WHERE l.id=$1 AND l.school_id=$2 AND a.academic_year_id=$3 AND t.user_id=$4 AND COALESCE(t.is_active,true)=true LIMIT 1`,[learnerId,req.params.schoolId,yearId,req.user.user_id])).rows[0];
 if(!ok)throw Object.assign(new Error('You can only access report cards for learners in your assigned class.'),{status:403});
}
async function enforceClassTeacherClass(req,classId,yearId,termId){
 if(req.user.role!=='CLASS_TEACHER')return;
 const ok=(await db.query(`SELECT 1 FROM class_teacher_assignments a JOIN teachers t ON t.id=a.teacher_id WHERE a.school_id=$1 AND a.class_id=$2 AND a.academic_year_id=$3 AND t.user_id=$4 AND COALESCE(t.is_active,true)=true LIMIT 1`,[req.params.schoolId,classId,yearId,req.user.user_id])).rows[0];
 if(!ok)throw Object.assign(new Error('You can only access report cards for your assigned class.'),{status:403});
}

router.get("/:schoolId/term/:learnerId/:yearId/:termId",schoolBoundary,roles("SCHOOL_ADMIN","ADMIN","HEADTEACHER","DEPUTY_HEADTEACHER","SENIOR_TEACHER","CLASS_TEACHER","TEACHER"),async(req,res)=>{try{await enforceClassTeacherLearner(req,req.params.learnerId,req.params.yearId);const r=await buildTermReport(req.params.schoolId,req.params.learnerId,req.params.yearId,req.params.termId);if(!r)return res.status(404).json({error:"Report not found"});res.json(r);}catch(e){console.error(e);res.status(500).json({error:"Report generation failed"});}});
router.get("/:schoolId/term/:learnerId/:yearId/:termId/pdf",schoolBoundary,roles("SCHOOL_ADMIN","ADMIN","HEADTEACHER","DEPUTY_HEADTEACHER","SENIOR_TEACHER","CLASS_TEACHER","TEACHER"),async(req,res)=>{try{await enforceClassTeacherLearner(req,req.params.learnerId,req.params.yearId);const r=await buildTermReport(req.params.schoolId,req.params.learnerId,req.params.yearId,req.params.termId);if(!r)return res.status(404).json({error:"Report not found"});await reportPdf(r,res);}catch(e){console.error(e);if(!res.headersSent)res.status(500).json({error:"PDF generation failed"});}});
router.get("/:schoolId/year/:learnerId/:yearId",schoolBoundary,roles("SCHOOL_ADMIN","ADMIN","HEADTEACHER","DEPUTY_HEADTEACHER","SENIOR_TEACHER","CLASS_TEACHER","TEACHER"),async(req,res)=>{try{await enforceClassTeacherLearner(req,req.params.learnerId,req.params.yearId);const r=await buildYearReport(req.params.schoolId,req.params.learnerId,req.params.yearId);if(!r)return res.status(404).json({error:"Annual report not found"});res.json(r);}catch(e){console.error(e);res.status(500).json({error:"Annual report generation failed"});}});
router.get("/:schoolId/year/:learnerId/:yearId/pdf",schoolBoundary,roles("SCHOOL_ADMIN","ADMIN","HEADTEACHER","DEPUTY_HEADTEACHER","SENIOR_TEACHER","CLASS_TEACHER","TEACHER"),async(req,res)=>{try{await enforceClassTeacherLearner(req,req.params.learnerId,req.params.yearId);const r=await buildYearReport(req.params.schoolId,req.params.learnerId,req.params.yearId);if(!r)return res.status(404).json({error:"Annual report not found"});await reportPdf(r,res);}catch(e){console.error(e);if(!res.headersSent)res.status(500).json({error:"PDF generation failed"});}});
router.get("/:schoolId/class/:classId/:yearId/:termId/pdf",schoolBoundary,roles("SCHOOL_ADMIN","ADMIN","HEADTEACHER","DEPUTY_HEADTEACHER","CLASS_TEACHER","SENIOR_TEACHER","TEACHER"),async(req,res)=>{try{
 const cls=(await db.query('SELECT id FROM classes WHERE id=$1 AND school_id=$2',[req.params.classId,req.params.schoolId])).rows[0];if(!cls)return res.status(404).json({error:'Class not found'});await enforceClassTeacherClass(req,req.params.classId,req.params.yearId,req.params.termId);
 const learners=(await db.query(`SELECT DISTINCT l.id FROM learners l
   JOIN learner_enrollments le ON le.learner_id=l.id AND le.school_id=l.school_id
   WHERE l.school_id=$1 AND le.class_id=$2 AND le.academic_year_id=$3 AND l.is_active=true
   ORDER BY l.id`,[req.params.schoolId,req.params.classId,req.params.yearId])).rows;
 const reports=[];
 // Build a few learner reports concurrently instead of doing dozens of full report
 // database round-trips strictly one after another. The small limit protects Neon.
 const limit=6;
 for(let i=0;i<learners.length;i+=limit){
   const batch=learners.slice(i,i+limit);
   const built=await Promise.all(batch.map(l=>buildTermReport(req.params.schoolId,l.id,req.params.yearId,req.params.termId)));
   built.forEach(r=>{if(r)reports.push(r);});
 }
 if(!reports.length)return res.status(404).json({error:"No learners are enrolled in this class for the selected academic year."});await reportPdfs(reports,res);}catch(e){console.error(e);if(!res.headersSent)res.status(500).json({error:"Class report PDF generation failed"});}});
router.get("/:schoolId/comments/:learnerId/:yearId/:termId",schoolBoundary,async(req,res)=>{const q=await db.query(`SELECT * FROM report_comments WHERE school_id=$1 AND learner_id=$2 AND academic_year_id=$3 AND term_id=$4 ORDER BY comment_type`,[req.params.schoolId,req.params.learnerId,req.params.yearId,req.params.termId]);res.json(q.rows);});
router.post("/:schoolId/comments",schoolBoundary,roles("SCHOOL_ADMIN","ADMIN","HEADTEACHER","DEPUTY_HEADTEACHER","CLASS_TEACHER","SENIOR_TEACHER","TEACHER"),async(req,res)=>{const b=req.body;try{const {assertBelongs}=require('../services/tenant');if(!b.learner_id||!b.academic_year_id||!b.term_id||!b.comment_type)return res.status(400).json({error:"Learner, year, term and comment type are required"});await assertBelongs('learners',b.learner_id,req.params.schoolId);await assertBelongs('academic_years',b.academic_year_id,req.params.schoolId);await assertBelongs('terms',b.term_id,req.params.schoolId);const q=await db.query(`INSERT INTO report_comments(school_id,learner_id,academic_year_id,term_id,comment_type,comment_text,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(learner_id,academic_year_id,term_id,comment_type) DO UPDATE SET comment_text=EXCLUDED.comment_text,created_by=EXCLUDED.created_by,updated_at=now() RETURNING *`,[req.params.schoolId,b.learner_id,b.academic_year_id,b.term_id,b.comment_type,b.comment_text||"",req.user.user_id]);res.json(q.rows[0]);}catch(e){res.status(e.status||400).json({error:e.message});}});
router.get('/:schoolId/designation/:learnerId/:yearId/:termId',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','CLASS_TEACHER','SENIOR_TEACHER','TEACHER'),async(req,res)=>{try{
 const q=await db.query(`SELECT designation,decision,attendance_days,school_open_days,conduct,effort,next_term_target,intervention_plan,teacher_comment,headteacher_comment
  FROM report_card_designations WHERE school_id=$1 AND learner_id=$2 AND academic_year_id=$3 AND term_id=$4`,[req.params.schoolId,req.params.learnerId,req.params.yearId,req.params.termId]);
 res.json(q.rows[0]||{});
}catch(e){res.status(400).json({error:e.message})}});
router.put('/:schoolId/designation',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','CLASS_TEACHER','SENIOR_TEACHER'),async(req,res)=>{try{
 const b=req.body||{};
 if(!b.learner_id||!b.academic_year_id||!b.term_id)return res.status(400).json({error:'Learner, academic year and term are required'});
 const allowedDesignation=['AUTO','DISTINCTION','MERIT','CREDIT','PASS','DEVELOPING','AT_RISK','INCOMPLETE'];
 const allowedDecision=['AUTO','PROMOTED','PROCEED','REPEAT','REVIEW','GRADUATED'];
 if(!allowedDesignation.includes(String(b.designation||'AUTO').toUpperCase()))return res.status(400).json({error:'Invalid designation'});
 if(!allowedDecision.includes(String(b.decision||'AUTO').toUpperCase()))return res.status(400).json({error:'Invalid progression decision'});
 const q=await db.query(`INSERT INTO report_card_designations(school_id,learner_id,academic_year_id,term_id,designation,decision,attendance_days,school_open_days,conduct,effort,next_term_target,intervention_plan,teacher_comment,headteacher_comment,updated_by)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
 ON CONFLICT(learner_id,academic_year_id,term_id) DO UPDATE SET designation=EXCLUDED.designation,decision=EXCLUDED.decision,attendance_days=EXCLUDED.attendance_days,school_open_days=EXCLUDED.school_open_days,conduct=EXCLUDED.conduct,effort=EXCLUDED.effort,next_term_target=EXCLUDED.next_term_target,intervention_plan=EXCLUDED.intervention_plan,teacher_comment=EXCLUDED.teacher_comment,headteacher_comment=EXCLUDED.headteacher_comment,updated_by=EXCLUDED.updated_by,updated_at=now()
 RETURNING *`,[req.params.schoolId,b.learner_id,b.academic_year_id,b.term_id,String(b.designation||'AUTO').toUpperCase(),String(b.decision||'AUTO').toUpperCase(),b.attendance_days===''||b.attendance_days==null?null:Number(b.attendance_days),b.school_open_days===''||b.school_open_days==null?null:Number(b.school_open_days),b.conduct||null,b.effort||null,b.next_term_target===''||b.next_term_target==null?null:Number(b.next_term_target),b.intervention_plan||null,b.teacher_comment||null,b.headteacher_comment||null,req.user.user_id]);
 res.json(q.rows[0]);
}catch(e){res.status(400).json({error:e.message})}});
module.exports=router;
