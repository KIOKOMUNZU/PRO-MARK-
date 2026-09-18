const express=require('express'),db=require('../db'),PDFDocument=require('pdfkit');
const {authenticate,schoolBoundary,roles}=require('../middleware/auth');
const {assertBelongs}=require('../services/tenant');
const {source:assetSource}=require('../services/assets');
const router=express.Router();router.use(authenticate);
function fmt(v){const n=Number(v);return Number.isFinite(n)?(Math.abs(n-Math.round(n))<0.00001?String(Math.round(n)):n.toFixed(2).replace(/0+$/,'').replace(/\.$/,'')):'—';}
function calc(values){const usable=values.filter(x=>Number.isFinite(x.percent));return usable.length?usable.reduce((s,x)=>s+x.percent,0)/usable.length:null;}
async function compute(sid,yearId,termId,classId=null){
 await assertBelongs('academic_years',yearId,sid);await assertBelongs('terms',termId,sid);
 const termInfo=(await db.query(`SELECT term_no FROM terms WHERE id=$1 AND school_id=$2`,[termId,sid])).rows[0];
 if(!termInfo)throw Object.assign(new Error('Term not found'),{status:404});
 const marks=(await db.query(`SELECT m.learner_id,l.admission_no,l.assessment_no,l.first_name,l.last_name,m.subject_id,s.code subject_code,s.name subject_name,m.mark,a.max_mark,a.weight,a.assessment_type,
           COALESCE((SELECT ac.include_in_merit FROM assessment_configurations ac WHERE ac.school_id=m.school_id AND ac.assessment_id=m.assessment_id AND (ac.subject_id=m.subject_id OR ac.subject_id IS NULL) ORDER BY (ac.subject_id IS NOT NULL) DESC,(ac.level_id IS NOT NULL) DESC,(ac.section_id IS NOT NULL) DESC LIMIT 1),true) include_in_merit,
           (SELECT ac.grading_system_id FROM assessment_configurations ac WHERE ac.school_id=m.school_id AND (ac.assessment_id=m.assessment_id OR ac.assessment_id IS NULL) AND (ac.subject_id=m.subject_id OR ac.subject_id IS NULL) ORDER BY (ac.subject_id IS NOT NULL) DESC,(ac.assessment_id IS NOT NULL) DESC,(ac.level_id IS NOT NULL) DESC,(ac.section_id IS NOT NULL) DESC LIMIT 1) grading_system_id FROM marks m JOIN learners l ON l.id=m.learner_id JOIN subjects s ON s.id=m.subject_id JOIN assessments a ON a.id=m.assessment_id WHERE m.school_id=$1 AND m.academic_year_id=$2 AND m.term_id=$3 AND l.is_active=true AND ($4::uuid IS NULL OR m.class_id=$4)
 AND a.assessment_type IN (${termInfo.term_no===3?"'OPENER','END_TERM'":"'OPENER','MID_TERM','END_TERM'"})
 ORDER BY l.last_name,l.first_name,s.name,a.assessment_order`,[sid,yearId,termId,classId])).rows;
 const byLearner=new Map();const seenAssessmentTypes=new Set();for(const r of marks){const at=String(r.assessment_type||'').toUpperCase();if(!['OPENER','MID_TERM','END_TERM'].includes(at)||seenAssessmentTypes.has(`${r.learner_id}|${r.subject_id}|${at}`)||r.include_in_merit===false||r.mark===null)continue;seenAssessmentTypes.add(`${r.learner_id}|${r.subject_id}|${at}`);const key=r.learner_id;if(!byLearner.has(key))byLearner.set(key,{learner_id:key,admission_no:r.admission_no,assessment_no:r.assessment_no,first_name:r.first_name,last_name:r.last_name,subjects:new Map()});const L=byLearner.get(key);if(!L.subjects.has(r.subject_id))L.subjects.set(r.subject_id,{subject_id:r.subject_id,subject_code:r.subject_code,subject_name:r.subject_name,items:[]});L.subjects.get(r.subject_id).items.push({percent:Number(r.mark)/Number(r.max_mark||100)*100,weight:Number(r.weight||0),grading_system_id:r.grading_system_id});}
 const gradingRows=(await db.query(`SELECT gs.id system_id,gs.name system_name,gs.code system_code,gb.label,gb.min_mark,gb.max_mark,gb.points FROM grading_systems gs JOIN grading_bands gb ON gb.grading_system_id=gs.id WHERE gs.school_id=$1`,[sid])).rows;
 const gradeFor=(value,systemId)=>{if(value===null)return null;const bands=gradingRows.filter(x=>!systemId||x.system_id===systemId);const competency=bands.filter(x=>['EE','ME','AE','BE'].includes(String(x.label||'').toUpperCase()));if(competency.length>=4){const hit=competency.find(x=>value>=Number(x.min_mark)&&value<=Number(x.max_mark));if(hit)return hit;}const n=Number(value);if(!Number.isFinite(n))return null;const fallback=n>=80?['EE',4,'Exceeds Expectations']:n>=60?['ME',3,'Meets Expectations']:n>=40?['AE',2,'Approaches Expectations']:['BE',1,'Below Expectations'];return {label:fallback[0],points:fallback[1],descriptor:fallback[2],min_mark:0,max_mark:100};};
 const rows=[...byLearner.values()].map(L=>{const subjects=[...L.subjects.values()].map(s=>{const average=calc(s.items);const systemId=s.items.find(i=>i.grading_system_id)?.grading_system_id||null;const g=gradeFor(average,systemId);return {...s,average,grade:g?.label||'',points:g?.points??'',grading_system_id:systemId};}).filter(s=>s.average!==null).sort((a,b)=>b.average-a.average||a.subject_name.localeCompare(b.subject_name));const average=subjects.length?subjects.reduce((s,x)=>s+x.average,0)/subjects.length:null;const total=subjects.reduce((s,x)=>s+x.average,0);const overallGrade=gradeFor(average,null);return {...L,subjects,average_mark:average,total_mark:total,overall_grade:overallGrade?.label||'',overall_points:overallGrade?.points??''};}).filter(x=>x.subjects.length).sort((a,b)=>b.average_mark-a.average_mark||b.total_mark-a.total_mark||a.last_name.localeCompare(b.last_name));
 const subjectMap=new Map();for(const r of rows)for(const s of r.subjects){if(!subjectMap.has(s.subject_id))subjectMap.set(s.subject_id,{subject_id:s.subject_id,subject_code:s.subject_code,subject_name:s.subject_name,values:[]});subjectMap.get(s.subject_id).values.push(s.average);}
 const teacherRows=classId?(await db.query(`SELECT DISTINCT ON (tsa.subject_id) tsa.subject_id,th.id teacher_id,th.first_name,th.last_name,th.staff_no FROM teacher_subject_assignments tsa JOIN teachers th ON th.id=tsa.teacher_id AND COALESCE(th.is_active,true)=true WHERE tsa.school_id=$1 AND tsa.class_id=$2 AND tsa.academic_year_id=$3 AND (tsa.term_id=$4 OR tsa.term_id IS NULL) AND COALESCE(tsa.is_active,true)=true AND NOT (upper(trim(coalesce(th.first_name,''))) IN ('TEACHER','ADMIN') OR upper(trim(coalesce(th.last_name,''))) IN ('TEACHER','ADMIN') OR upper(trim(coalesce(th.staff_no,''))) IN ('TEACHER','ADMIN','MR.TEACHER','MR. TEACHER')) ORDER BY tsa.subject_id,(tsa.term_id IS NOT NULL) DESC,tsa.created_at DESC,tsa.id DESC`,[sid,classId,yearId,termId])).rows:[];
 const teacherBySubject=new Map(teacherRows.map(x=>[x.subject_id, x]));
 const isPlaceholderTeacher=x=>{const f=String(x?.first_name||'').trim().toUpperCase(),l=String(x?.last_name||'').trim().toUpperCase(),s=String(x?.staff_no||'').trim().toUpperCase();return !f&&!l || f==='TEACHER'||l==='TEACHER'||f==='ADMIN'||l==='ADMIN'||s==='TEACHER'||s==='ADMIN';};
 const teacherLabel=x=>{if(!x||isPlaceholderTeacher(x))return 'Not assigned';const full=[x.first_name,x.last_name].filter(Boolean).join(' ').trim();return full||'Not assigned';};
 const subject_rankings=[...subjectMap.values()].map(s=>{const average=s.values.reduce((a,b)=>a+b,0)/s.values.length;const g=gradeFor(average,null);return {...s,average,learner_count:s.values.length,grade:g?.label||'',points:g?.points??'',teacher_name:teacherLabel(teacherBySubject.get(s.subject_id))};}).sort((a,b)=>b.average-a.average||a.subject_name.localeCompare(b.subject_name));
 return {rows,subject_rankings};
}
router.get('/:schoolId',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'),async(req,res)=>{try{const sid=req.params.schoolId,cls=req.query.class_id||null,y=req.query.academic_year_id||null,t=req.query.term_id||null;if(req.user.role==='CLASS_TEACHER'){if(!cls)return res.status(400).json({error:'Select your assigned class.'});const ok=(await db.query(`SELECT 1 FROM class_teacher_assignments a JOIN teachers th ON th.id=a.teacher_id WHERE a.school_id=$1 AND a.class_id=$2 AND a.academic_year_id=$3 AND th.user_id=$4 AND COALESCE(th.is_active,true)=true LIMIT 1`,[sid,cls,y,req.user.user_id])).rows[0];if(!ok)return res.status(403).json({error:'You can only view merit for your assigned class.'});}res.json(await compute(sid,y,t,cls));}catch(e){res.status(e.status||400).json({error:e.message});}});
router.post('/:schoolId/runs',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER'),async(req,res)=>{try{const b=req.body,r=await compute(req.params.schoolId,b.academic_year_id,b.term_id,b.class_id||null);const q=await db.query(`INSERT INTO merit_runs(school_id,academic_year_id,term_id,basis,filters,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[req.params.schoolId,b.academic_year_id,b.term_id,b.basis||'AVERAGE',JSON.stringify(b.filters||{}),req.user.user_id]);res.status(201).json({run:q.rows[0],...r});}catch(e){res.status(e.status||400).json({error:e.message});}});
router.get('/:schoolId/pdf',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN','HEADTEACHER','DEPUTY_HEADTEACHER','SENIOR_TEACHER','CLASS_TEACHER','TEACHER'),async(req,res)=>{try{
 const sid=req.params.schoolId,yearId=req.query.academic_year_id,termId=req.query.term_id,classId=req.query.class_id||null;
 if(!classId)return res.status(400).json({error:'Select a class before generating the merit PDF.'});
 if(req.user.role==='CLASS_TEACHER'){const ok=(await db.query(`SELECT 1 FROM class_teacher_assignments a JOIN teachers th ON th.id=a.teacher_id WHERE a.school_id=$1 AND a.class_id=$2 AND a.academic_year_id=$3 AND th.user_id=$4 AND COALESCE(th.is_active,true)=true LIMIT 1`,[sid,classId,yearId,req.user.user_id])).rows[0];if(!ok)return res.status(403).json({error:'You can only download merit for your assigned class.'});}
 const r=await compute(sid,yearId,termId,classId);
 const meta=(await db.query(`SELECT s.name school_name,s.code school_code,si.logo_url,si.motto,si.address,si.contact_phone,si.contact_email,si.primary_color,si.secondary_color,
   (SELECT file_url FROM school_document_assets da WHERE da.school_id=s.id AND da.asset_type='STAMP' AND da.is_active=true ORDER BY da.effective_from DESC,da.created_at DESC LIMIT 1) stamp_url,
   ay.year_label,t.name term_name,c.name class_name,c.stream
   FROM schools s LEFT JOIN school_identity si ON si.school_id=s.id
   JOIN academic_years ay ON ay.id=$2 JOIN terms t ON t.id=$3
   JOIN classes c ON c.id=$4 WHERE s.id=$1`,[sid,yearId,termId,classId])).rows[0]||{};
 const configuredSubjects=(await db.query(`SELECT DISTINCT ON (s.id) s.id subject_id,s.code subject_code,s.name subject_name
   FROM teacher_subject_assignments tsa JOIN subjects s ON s.id=tsa.subject_id
   WHERE tsa.school_id=$1 AND tsa.class_id=$2 AND tsa.academic_year_id=$3 AND (tsa.term_id=$4 OR tsa.term_id IS NULL)
   ORDER BY s.id,(tsa.term_id IS NOT NULL) DESC,tsa.created_at,tsa.id`,[sid,classId,yearId,termId])).rows;
 const subjects=configuredSubjects.length?configuredSubjects:[...new Map(r.rows.flatMap(x=>x.subjects).map(s=>[s.subject_id,s])).values()];

 // Merit uses one fixed landscape width. The height is allowed to continue onto as many
 // pages as necessary; rows are never forced into a single giant page.
 const pageSize='A4';
 const doc=new PDFDocument({size:pageSize,layout:'landscape',margin:18,autoFirstPage:false});
 const chunks=[];
 doc.on('data',chunk=>chunks.push(chunk));
 const pdfDone=new Promise((resolve,reject)=>{doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
 // Explicitly create the first page before accessing doc.page.
 doc.addPage({size:pageSize,layout:'landscape',margin:18});
 const pageW=doc.page.width,pageH=doc.page.height,margin=28,tableW=pageW-margin*2,x0=margin;
 const navy=(String(meta.primary_color||'').toUpperCase()==='#17365D'?'#0B4F8A':meta.primary_color)||'#0B4F8A',gold=(String(meta.secondary_color||'').toUpperCase()==='#D9A441'?'#16A36A':meta.secondary_color)||'#16A36A',ink='#111111',muted='#374151',grid='#111111';
 const fixed=[58,58,155],tail=[50,50,50];
 const available=tableW-fixed.reduce((a,b)=>a+b,0)-tail.reduce((a,b)=>a+b,0);
 const subjectW=subjects.length?Math.max(18,available/subjects.length):available;
 const widths=[...fixed,...subjects.map(()=>subjectW),...tail];
 const headerH=38,rowH=28;
 const gradeFill=g=>g==='EE'?'#DDF4E4':g==='ME'?'#E5F0FB':g==='AE'?'#FFF0C9':g==='BE'?'#FBE0E0':'#F5F7FA';

 // Branding is shown as a header on the same page as the data — no separate
 // near-empty cover page, so nothing is skipped over when flipping/printing.
 let y=42;
 const drawPageHeader=()=>{
   const logoPath=assetSource(meta.logo_url);
   if(logoPath)try{doc.image(logoPath,x0,y,{fit:[48,48]});}catch{}
   // Subtle PRO-MARK identity watermark, analogous to a document security watermark.
   if(logoPath)try{doc.save().opacity(.055);doc.image(logoPath,x0+tableW/2-115,pageH/2-115,{fit:[230,230],align:'center',valign:'center'});doc.restore();}catch{}
   doc.fillColor(navy).font('Helvetica-Bold').fontSize(13).text(meta.school_name||'SCHOOL',x0+48,y+2,{width:tableW-48});
   doc.fillColor(ink).font('Helvetica-Bold').fontSize(10).text('CLASS MERIT REPORT',x0+48,y+20,{width:tableW-48});
   doc.fillColor(muted).font('Helvetica').fontSize(7).text(`${meta.year_label||''} • ${meta.term_name||''} • ${meta.class_name||''}${meta.stream?' · '+meta.stream:''}`,x0+48,y+35,{width:tableW-48});
   y+=52;
   doc.moveTo(x0,y).lineTo(x0+tableW,y).strokeColor(gold).lineWidth(1.4).stroke();y+=13;
   doc.fillColor(ink).font('Helvetica-Bold').fontSize(8).text('MERIT / MARK SHEET',x0,y);
   doc.fillColor(muted).font('Helvetica').fontSize(6.2).text('Highest overall average first • Mark + CBC competency level (EE / ME / AE / BE).',x0+100,y+1,{width:tableW-100});
   y+=18;
   let xx=x0;doc.fillColor(navy).rect(x0,y,tableW,headerH).fill();
   const heads=['ADM. NO.','ASSES. NO.','STUDENT NAME',...subjects.map(s=>(s.subject_code||s.subject_name||'').toUpperCase()),'TOTAL','AVERAGE','GRADE'];
   heads.forEach((h,i)=>{doc.fillColor('#fff').font('Helvetica-Bold').fontSize(i<3?5.8:4.5);doc.text(String(h),xx+2,y+7,{width:widths[i]-4,height:headerH-10,align:i<3?'left':'center',lineBreak:false,ellipsis:true});if(i<heads.length-1){doc.strokeColor('#FFFFFF').lineWidth(.7).moveTo(xx+widths[i],y).lineTo(xx+widths[i],y+headerH).stroke();}xx+=widths[i];});
   y+=headerH;
 };
 const footer=()=>{doc.fillColor(muted).font('Helvetica').fontSize(5.8).text(`PRO-MARK • ${meta.contact_email||'School contact email'} • ${meta.class_name||''}${meta.stream?' · '+meta.stream:''} • Page ${doc.page.index+1}`,x0,pageH-20,{width:tableW,align:'right'});};
 drawPageHeader();
 r.rows.forEach((row,idx)=>{
   if(y+rowH>pageH-32){footer();doc.addPage({size:pageSize,layout:'landscape',margin:18});y=42;drawPageHeader();}
   let x=x0;
   if(idx%2===0)doc.save().fillColor('#FBFCFD').rect(x,y,tableW,rowH).fill().restore();
   doc.strokeColor(grid).lineWidth(1).rect(x,y,tableW,rowH).stroke();
   let gx=x; widths.forEach((wi)=>{gx+=wi; if(gx<x+tableW-.1){doc.moveTo(gx,y).lineTo(gx,y+rowH).stroke();}});
   const core=[row.admission_no||'',row.assessment_no||'',`${row.first_name||''} ${row.last_name||''}`.trim()||'—'];
   core.forEach((v,i)=>{doc.fillColor(ink).font(i===2?'Helvetica-Bold':'Helvetica').fontSize(i===2?6.5:6);doc.text(String(v),x+3,y+12,{width:widths[i]-6,height:rowH-8,align:'left',ellipsis:true,lineBreak:false});x+=widths[i];});
   subjects.forEach(sub=>{
     const got=(row.subjects||[]).find(s=>s.subject_id===sub.subject_id);
     const mark=got?.average==null?'':fmt(got.average),grade=got?.grade||'';
     doc.fillColor(ink).font('Helvetica-Bold').fontSize(5.4).text(mark,x+1,y+5,{width:widths[3]-2,align:'center'});
     doc.fillColor(gradeFill(grade)).rect(x+2,y+18,widths[3]-4,11).fill();
     doc.fillColor(ink).font('Helvetica-Bold').fontSize(5).text(grade,x+2,y+20,{width:widths[3]-4,align:'center'});x+=widths[3];
   });
   const vals=[fmt(row.total_mark),fmt(row.average_mark),row.overall_grade||''];
   vals.forEach((v,j)=>{const wi=tail[j];if(j===2)doc.fillColor(gradeFill(v)).rect(x,y,wi,rowH).fill();doc.fillColor(ink).font('Helvetica-Bold').fontSize(6).text(String(v),x+2,y+12,{width:wi-4,align:'center'});x+=wi;});
   y+=rowH;
 });

 // Subject averages summary is part of the merit report and is always rendered
 // after the learner register, continuing onto a new page only when necessary.
 const summaryTitleH=24, summaryRowH=18;
 const summaryRows=r.subject_rankings||[];
 const summaryNeeded=summaryTitleH + summaryRows.length*summaryRowH + 28;
 if(summaryRows.length){
   if(y+summaryNeeded>pageH-28){
     footer();
     doc.addPage({size:pageSize,layout:'landscape',margin:18});
     y=42;
     drawPageHeader();
   }
   doc.fillColor(navy).font('Helvetica-Bold').fontSize(9).text('SUBJECT AVERAGES • CLASS RANKING • SUBJECT TEACHERS',x0,y);
   y+=12;
   const sw=[38,210,70,58,120];
   const sh=['RANK','SUBJECT / LEARNING AREA','CLASS AVERAGE','GRADE','SUBJECT TEACHER'];
   let sx=x0;
   doc.fillColor(navy).rect(x0,y,tableW,18).fill();
   sh.forEach((h,i)=>{doc.fillColor('#fff').font('Helvetica-Bold').fontSize(5.5).text(h,sx+2,y+6,{width:sw[i]-4,align:i===1||i===4?'left':'center',lineBreak:false});if(i<sh.length-1){doc.strokeColor('#FFFFFF').lineWidth(.7).moveTo(sx+sw[i],y).lineTo(sx+sw[i],y+18).stroke();}sx+=sw[i];});
   y+=18;
   summaryRows.forEach((sr,i)=>{
     if(y+summaryRowH>pageH-28){
       footer(); doc.addPage({size:'A4',layout:'landscape',margin:18}); y=42; drawPageHeader();
       doc.fillColor(navy).font('Helvetica-Bold').fontSize(8).text('SUBJECT AVERAGES • CONTINUED',x0,y); y+=12;
     }
     if(i%2===0)doc.save().fillColor('#FBFCFD').rect(x0,y,tableW,summaryRowH).fill().restore();
     doc.strokeColor(grid).lineWidth(1).rect(x0,y,tableW,summaryRowH).stroke();
     let sg=x0; sw.forEach((wi)=>{sg+=wi; if(sg<x0+tableW-.1){doc.moveTo(sg,y).lineTo(sg,y+summaryRowH).stroke();}});
     const vals=[String(i+1),String(sr.subject_name||sr.subject_code||'—'),fmt(sr.average),String(sr.grade||'—'),String(sr.teacher_name||'—')];
     let xx=x0; vals.forEach((v,j)=>{doc.fillColor(ink).font(j===1||j===4?'Helvetica-Bold':'Helvetica').fontSize(5.8).text(v,xx+3,y+6,{width:sw[j]-6,align:j===1||j===4?'left':'center',ellipsis:true,lineBreak:false});xx+=sw[j];});
     y+=summaryRowH;
   });
   y+=6;
 }
 footer();doc.end();
 const pdf=await pdfDone;
 res.setHeader('Content-Type','application/pdf');
 res.setHeader('Content-Disposition','inline; filename="pro-mark-merit-list.pdf"');
 res.end(pdf);
 }catch(e){console.error('Merit PDF failed:',e);if(!res.headersSent)res.status(e.status||400).json({error:e.message||'Unable to create merit PDF'});}});
module.exports=router;
