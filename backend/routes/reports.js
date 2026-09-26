const express=require("express"),db=require("../db");
const {authenticate,schoolBoundary,roles}=require("../middleware/auth");
const {buildTermReport,buildYearReport}=require("../services/report-engine");
const {reportPdf,reportPdfs,buildReportPdfsBuffer}=require("../services/report-pdf");
const router=express.Router();router.use(authenticate);
const classReportPdfCache=new Map();
function getClassReportPdf(key){const hit=classReportPdfCache.get(key);if(hit&&hit.expires>Date.now())return hit.value;if(hit)classReportPdfCache.delete(key);return null;}
function putClassReportPdf(key,value){classReportPdfCache.set(key,{value,expires:Date.now()+15000});if(classReportPdfCache.size>24){const oldest=[...classReportPdfCache.entries()].sort((a,b)=>a[1].expires-b[1].expires)[0];if(oldest)classReportPdfCache.delete(oldest[0]);}}
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

router.get("/:schoolId/term/:learnerId/:yearId/:termId",schoolBoundary,roles("SCHOOL_ADMIN","ADMIN","HEADTEACHER","DEPUTY_HEADTEACHER","SENIOR_TEACHER","CLASS_TEACHER","TEACHER"),async(req,res)=>{try{await enforceClassTeacherLearner(req,req.params.learnerId,req.params.yearId);const r=await buildTermReport(req.params.schoolId,req.params.learnerId,req.params.yearId,req.params.termId);if(!r)return res.status(404).json({error:"Report not found"});res.json(r); }catch(e){console.error('[PRO-MARK term report]',e);res.status(e.status||500).json({error:e.message||'Report generation failed'});}});
router.get("/:schoolId/term/:learnerId/:yearId/:termId/pdf",schoolBoundary,roles("SCHOOL_ADMIN","ADMIN","HEADTEACHER","DEPUTY_HEADTEACHER","SENIOR_TEACHER","CLASS_TEACHER","TEACHER"),async(req,res)=>{try{await enforceClassTeacherLearner(req,req.params.learnerId,req.params.yearId);const r=await buildTermReport(req.params.schoolId,req.params.learnerId,req.params.yearId,req.params.termId);if(!r)return res.status(404).json({error:"Report not found"});await reportPdf(r,res); }catch(e){console.error('[PRO-MARK term report PDF]',e);if(!res.headersSent)res.status(e.status||500).json({error:e.message||'PDF generation failed'});}});
router.get("/:schoolId/year/:learnerId/:yearId",schoolBoundary,roles("SCHOOL_ADMIN","ADMIN","HEADTEACHER","DEPUTY_HEADTEACHER","SENIOR_TEACHER","CLASS_TEACHER","TEACHER"),async(req,res)=>{try{await enforceClassTeacherLearner(req,req.params.learnerId,req.params.yearId);const r=await buildYearReport(req.params.schoolId,req.params.learnerId,req.params.yearId);if(!r)return res.status(404).json({error:"Annual report not found"});res.json(r); }catch(e){console.error('[PRO-MARK annual report]',e);res.status(e.status||500).json({error:e.message||'Annual report generation failed'});}});
router.get("/:schoolId/year/:learnerId/:yearId/pdf",schoolBoundary,roles("SCHOOL_ADMIN","ADMIN","HEADTEACHER","DEPUTY_HEADTEACHER","SENIOR_TEACHER","CLASS_TEACHER","TEACHER"),async(req,res)=>{try{await enforceClassTeacherLearner(req,req.params.learnerId,req.params.yearId);const r=await buildYearReport(req.params.schoolId,req.params.learnerId,req.params.yearId);if(!r)return res.status(404).json({error:"Annual report not found"});await reportPdf(r,res); }catch(e){console.error('[PRO-MARK annual report PDF]',e);if(!res.headersSent)res.status(e.status||500).json({error:e.message||'PDF generation failed'});}});
router.get("/:schoolId/class/:classId/:yearId/:termId/pdf",schoolBoundary,roles("SCHOOL_ADMIN","ADMIN","HEADTEACHER","DEPUTY_HEADTEACHER","CLASS_TEACHER","SENIOR_TEACHER","TEACHER"),async(req,res)=>{try{
 const cls=(await db.query('SELECT id FROM classes WHERE id=$1 AND school_id=$2',[req.params.classId,req.params.schoolId])).rows[0];if(!cls)return res.status(404).json({error:'Class not found'});await enforceClassTeacherClass(req,req.params.classId,req.params.yearId,req.params.termId);
 const learners=(await db.query(`SELECT DISTINCT l.id,l.first_name,l.middle_name,l.last_name FROM learners l WHERE l.school_id=$1 AND (l.class_id=$2 OR EXISTS (SELECT 1 FROM learner_enrollments le WHERE le.learner_id=l.id AND le.school_id=$1 AND le.academic_year_id=$3 AND le.class_id=$2 AND COALESCE(le.status,'ACTIVE') IN ('ACTIVE','COMPLETED')) OR (EXISTS (SELECT 1 FROM marks mx WHERE mx.school_id=l.school_id AND mx.learner_id=l.id AND mx.academic_year_id=$3 AND mx.term_id=$4 AND mx.class_id=$2) AND NOT EXISTS (SELECT 1 FROM learner_enrollments lex WHERE lex.learner_id=l.id AND lex.school_id=$1 AND lex.academic_year_id=$3))) ORDER BY l.last_name NULLS LAST,l.first_name NULLS LAST,l.middle_name NULLS LAST,l.id`,[req.params.schoolId,req.params.classId,req.params.yearId,req.params.termId])).rows;
 const reports=[];
 // FIX: a learner that buildTermReport() cannot produce a report for used to be
 // silently dropped — the admin only ever saw a shorter PDF with no explanation.
 // Diagnose and surface exactly which learners were skipped and why, via a header
 // the frontend already reads and can display.
 const skipped=[];
 // Build a few learner reports concurrently instead of doing dozens of full report
 // database round-trips strictly one after another. The small limit protects Neon.
 const limit=8;
 for(let i=0;i<learners.length;i+=limit){
   const batch=learners.slice(i,i+limit);
   const built=await Promise.all(batch.map(async l=>{
     try{return {learner:l,report:await buildTermReport(req.params.schoolId,l.id,req.params.yearId,req.params.termId)};}
     catch(e){return {learner:l,report:null,error:e.message};}
   }));
   for(const item of built){
     if(item.report){reports.push(item.report);continue;}
     const name=[item.learner.first_name,item.learner.middle_name,item.learner.last_name].filter(Boolean).join(' ')||item.learner.id;
     let reason=item.error;
     if(!reason){
       // buildTermReport() returned null rather than throwing. The only place it
       // does that is when the school/learner/year/term combination has no matching
       // row — narrow down which specific piece is missing so this is diagnosable
       // without database access.
       const[yearRow,termRow]=await Promise.all([
         db.query('SELECT 1 FROM academic_years WHERE id=$1 AND school_id=$2',[req.params.yearId,req.params.schoolId]),
         db.query('SELECT 1 FROM terms WHERE id=$1 AND school_id=$2 AND academic_year_id=$3',[req.params.termId,req.params.schoolId,req.params.yearId])
       ]);
       if(!yearRow.rows[0])reason='The selected academic year could not be found for this school.';
       else if(!termRow.rows[0])reason='The selected term does not belong to the selected academic year.';
       else reason='No matching record was found for this learner under the selected school/year/term (data integrity issue — check the learner\'s school_id).';
     }
     skipped.push({id:item.learner.id,name,reason});
   }
 }
 if(!reports.length){ const detail=learners.length?`Learners were found in this class (${learners.length}), but none could produce a report for the selected year and term.`:`No learners are enrolled in this class for the selected academic year, and no matching saved marks were found.`; return res.status(404).json({error:detail,learners_found:learners.length,skipped}); }
 if(skipped.length)res.setHeader('X-Pro-Mark-Skipped',Buffer.from(JSON.stringify(skipped)).toString('base64'));
 const cacheKey=`${req.params.schoolId}|${req.params.classId}|${req.params.yearId}|${req.params.termId}`;
 const cachedPdf=getClassReportPdf(cacheKey);
 const built=cachedPdf||await buildReportPdfsBuffer(reports);
 if(!cachedPdf)putClassReportPdf(cacheKey,built);
 res.setHeader('Content-Type','application/pdf');
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Pro-Mark-Report-Count',String(built.count));
 res.setHeader('X-Pro-Mark-Page-Count',String(built.pages));
 res.setHeader('Content-Disposition',`${String(req.query.download||'')==='1'?'attachment':'inline'}; filename="class-report-cards.pdf"`);
 res.end(built.bytes); }catch(e){console.error('[PRO-MARK class report PDF]',e);if(!res.headersSent)res.status(e.status||500).json({error:e.message||'Class report PDF generation failed'});}});
router.get('/:schoolId/class/:classId/:yearId/:termId/learners',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','CLASS_TEACHER','SENIOR_TEACHER','TEACHER'),async(req,res)=>{try{await enforceClassTeacherClass(req,req.params.classId,req.params.yearId,req.params.termId);const q=await db.query(`SELECT l.id,l.admission_no,l.assessment_no,l.first_name,l.middle_name,l.last_name FROM learners l JOIN learner_enrollments le ON le.learner_id=l.id AND le.school_id=l.school_id WHERE l.school_id=$1 AND le.academic_year_id=$2 AND le.class_id=$3 AND COALESCE(le.status,'ACTIVE') IN ('ACTIVE','COMPLETED') ORDER BY l.last_name NULLS LAST,l.first_name NULLS LAST,l.middle_name NULLS LAST,l.id`,[req.params.schoolId,req.params.yearId,req.params.classId]);res.json(q.rows);}catch(e){res.status(e.status||400).json({error:e.message})}});
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
