const db = require("../db");

function finite(n) { const x = Number(n); return Number.isFinite(x) ? x : null; }
function avg(values) {
  const a = values.map(finite).filter(v => v !== null);
  return a.length ? a.reduce((x,y)=>x+y,0)/a.length : null;
}
function weighted(items) {
  const usable = items.filter(x => finite(x.value) !== null && Number(x.weight) > 0);
  const w = usable.reduce((s,x)=>s+Number(x.weight),0);
  return w ? usable.reduce((s,x)=>s+Number(x.value)*Number(x.weight),0)/w : null;
}
function gradeFor(mark,bands) {
  const n = finite(mark);
  if (n === null) return null;
  const competency=(bands||[]).filter(b=>['EE','ME','AE','BE'].includes(String(b.label||'').toUpperCase()));
  if(competency.length>=4){const hit=competency.find(b => n >= Number(b.min_mark) && n <= Number(b.max_mark));if(hit)return hit;}
  const f=n>=80?['EE',4,'Exceeds Expectations']:n>=60?['ME',3,'Meets Expectations']:n>=40?['AE',2,'Approaches Expectations']:['BE',1,'Below Expectations'];
  return {label:f[0],points:f[1],descriptor:f[2],remark:f[2]};
}
function autoDesignation(mark) {
  const n=finite(mark);
  if(n===null)return 'INCOMPLETE';
  if(n>=80)return 'DISTINCTION';
  if(n>=70)return 'MERIT';
  if(n>=60)return 'CREDIT';
  if(n>=50)return 'PASS';
  if(n>=40)return 'DEVELOPING';
  return 'AT_RISK';
}
function autoDecision(mark) {
  const n=finite(mark);
  if(n===null)return 'REVIEW';
  return n>=50?'PROMOTED':'REVIEW';
}
function teacherInitials(first,last,staffNo) {
  const staff=String(staffNo||"").trim();
  const m=staff.match(/^(MD|MR|MRS|MS)\.\s*([A-Z]+)/i);
  if(m) return (m[1][0]+m[2][0]).toUpperCase();
  return [first,last].filter(Boolean).map(x=>String(x).trim()[0]).join("").toUpperCase();
}
function teacherDisplay(first,last,staffNo) {
  const full=[first,last].filter(Boolean).map(v=>String(v).trim()).filter(Boolean).join(' ').toUpperCase();
  if(full)return full;
  return String(staffNo||'').trim().toUpperCase();
}
function isPlaceholderTeacher(t) {
  const first=String(t?.teacher_first_name||t?.first_name||'').trim().toUpperCase();
  const last=String(t?.teacher_last_name||t?.last_name||'').trim().toUpperCase();
  const staff=String(t?.staff_no||'').trim().toUpperCase();
  return !first && !last || last==='TEACHER' || first==='TEACHER' || staff==='TEACHER' || staff==='MR.TEACHER' || staff==='MR. TEACHER';
}

// Short-lived caches remove repeated configuration/assignment queries when a whole
// class of report cards is generated. They are intentionally small and expire quickly
// so an administrator's assignment change is reflected without a server restart.
const reportCache=new Map();
function cached(key,ttl,loader){
  const now=Date.now(),hit=reportCache.get(key);
  if(hit && hit.expires>now)return hit.value;
  const value=Promise.resolve().then(loader);
  reportCache.set(key,{value,expires:now+ttl});
  value.catch(()=>reportCache.delete(key));
  return value;
}
function autoSubjectComment(s){
  if(s.average===null || s.average===undefined)return '';
  const n=Number(s.average);
  if(n>=80)return 'Excellent performance. Keep it up.';
  if(n>=70)return 'Very good performance. Keep improving.';
  if(n>=60)return 'Good effort. More practice is needed.';
  if(n>=50)return 'Fair performance. Put in more effort.';
  return 'Needs improvement and more support.';
}

async function getContext(schoolId, learnerId, yearId, termId) {
  const meta = (await db.query(`
    SELECT l.id learner_id,l.admission_no,l.assessment_no,l.passport_photo_url,l.first_name,l.middle_name,l.last_name,COALESCE(le.class_id,l.class_id) class_id,
           c.name class_name,c.stream,sl.id level_id,sl.code level_code,sl.name level_name,
           ss.id section_id,ss.code section_code,ss.name section_name,
           s.name school_name,s.code school_code,si.logo_url,si.motto,si.primary_color,si.secondary_color,
           si.address,si.contact_phone,si.contact_email,si.watermark_enabled,ay.year_label,ay.identity_snapshot,
           t.id term_id,t.term_no,t.name term_name,t.opening_date,t.closing_date
    FROM learners l
    JOIN schools s ON s.id=l.school_id
    JOIN school_identity si ON si.school_id=s.id
    JOIN academic_years ay ON ay.id=$3 AND ay.school_id=l.school_id
    JOIN terms t ON t.id=$4 AND t.school_id=l.school_id AND t.academic_year_id=ay.id
    LEFT JOIN learner_enrollments le ON le.school_id=l.school_id AND le.learner_id=l.id AND le.academic_year_id=ay.id
    LEFT JOIN classes c ON c.id=COALESCE(le.class_id,l.class_id)
    LEFT JOIN school_levels sl ON sl.id=c.school_level_id
    LEFT JOIN school_sections ss ON ss.id=sl.school_section_id
    WHERE l.school_id=$1 AND l.id=$2`, [schoolId,learnerId,yearId,termId])).rows[0];
  if(!meta)return null;
  const snap=meta.identity_snapshot && typeof meta.identity_snapshot==='object' ? meta.identity_snapshot : {};
  if(Object.keys(snap).length){
    meta.school_name=snap.school_name||meta.school_name;
    meta.motto=snap.motto??meta.motto;
    meta.logo_url=snap.logo_url??meta.logo_url;
    meta.primary_color=snap.primary_color||meta.primary_color;
    meta.secondary_color=snap.secondary_color||meta.secondary_color;
    meta.address=snap.address??meta.address;
    meta.contact_phone=snap.contact_phone??meta.contact_phone;
    // Always use the school's current registered contact email in live documents.
    // Historical identity snapshots must not reintroduce the platform owner's email.
    meta.watermark_enabled=snap.watermark_enabled??meta.watermark_enabled;
  }
  return meta;
}

async function resolveGrading(schoolId, meta, assessmentId=null, subjectId=null) {
  const key=`grading|${schoolId}|${meta.section_id||''}|${meta.level_id||''}|${assessmentId||''}|${subjectId||''}`;
  return cached(key,30000,async()=>{
  const q = await db.query(`
    SELECT gs.id,gs.name,gs.code,gb.label,gb.min_mark,gb.max_mark,gb.points,gb.descriptor,gb.remark
    FROM grading_systems gs
    JOIN grading_bands gb ON gb.grading_system_id=gs.id
    LEFT JOIN assessment_configurations ac
      ON ac.grading_system_id=gs.id AND ac.school_id=$1
     AND (ac.section_id=$2 OR ac.section_id IS NULL)
     AND (ac.level_id=$3 OR ac.level_id IS NULL)
     AND (ac.assessment_id=$4 OR ac.assessment_id IS NULL)
     AND (ac.subject_id=$5 OR ac.subject_id IS NULL)
    WHERE gs.school_id=$1 AND gs.is_active=true
    ORDER BY (ac.subject_id IS NOT NULL) DESC,(ac.level_id IS NOT NULL) DESC,
             (ac.section_id IS NOT NULL) DESC,(ac.assessment_id IS NOT NULL) DESC,
             gs.id,gb.min_mark DESC`, [schoolId,meta.section_id,meta.level_id,assessmentId,subjectId]);
  if (!q.rows.length) return {system:null,bands:[]};
  const system = q.rows[0];
  return {system:{id:system.id,name:system.name,code:system.code},bands:q.rows.filter(x=>x.id===system.id)};
  });
}

async function buildTermReport(schoolId, learnerId, yearId, termId) {
  const meta = await getContext(schoolId,learnerId,yearId,termId);
  if (!meta) return null;
  const assessments = await cached(`assessments|${schoolId}|${yearId}|${termId}|${meta.section_id||''}|${meta.level_id||''}`,30000,async()=> (await db.query(`
    SELECT a.*,
      COALESCE((SELECT ac.include_in_term_average FROM assessment_configurations ac
        WHERE ac.school_id=a.school_id AND ac.assessment_id=a.id AND ac.subject_id IS NULL
          AND (ac.section_id=$4 OR ac.section_id IS NULL) AND (ac.level_id=$5 OR ac.level_id IS NULL)
        ORDER BY (ac.level_id IS NOT NULL) DESC,(ac.section_id IS NOT NULL) DESC LIMIT 1),true) include_in_term_average,
      COALESCE((SELECT ac.include_in_merit FROM assessment_configurations ac
        WHERE ac.school_id=a.school_id AND ac.assessment_id=a.id AND ac.subject_id IS NULL
          AND (ac.section_id=$4 OR ac.section_id IS NULL) AND (ac.level_id=$5 OR ac.level_id IS NULL)
        ORDER BY (ac.level_id IS NOT NULL) DESC,(ac.section_id IS NOT NULL) DESC LIMIT 1),true) include_in_merit
    FROM assessments a
    WHERE a.school_id=$1 AND a.academic_year_id=$2 AND a.term_id=$3
    ORDER BY a.assessment_order,a.created_at,a.name`,[schoolId,yearId,termId,meta.section_id,meta.level_id])).rows);

  const marks = (await db.query(`
    SELECT m.subject_id,s.code subject_code,s.name subject_name,a.id assessment_id,a.name assessment_name,
           a.assessment_type,a.max_mark,a.weight,m.mark,m.remark,
           th.staff_no,th.first_name teacher_first_name,th.last_name teacher_last_name,
           th2.staff_no entered_teacher_staff_no,th2.first_name entered_teacher_first_name,th2.last_name entered_teacher_last_name,
           u2.first_name entered_user_first_name,u2.last_name entered_user_last_name,
           COALESCE((SELECT ac.include_in_term_average FROM assessment_configurations ac
             WHERE ac.school_id=m.school_id AND ac.assessment_id=m.assessment_id
               AND (ac.subject_id=m.subject_id OR ac.subject_id IS NULL)
               AND (ac.section_id=$5 OR ac.section_id IS NULL) AND (ac.level_id=$6 OR ac.level_id IS NULL)
             ORDER BY (ac.subject_id IS NOT NULL) DESC,(ac.level_id IS NOT NULL) DESC,(ac.section_id IS NOT NULL) DESC LIMIT 1),true) include_in_term_average
    FROM marks m JOIN subjects s ON s.id=m.subject_id
    JOIN assessments a ON a.id=m.assessment_id
    LEFT JOIN LATERAL (
      SELECT tsa.teacher_id
      FROM teacher_subject_assignments tsa
      JOIN teachers tassign ON tassign.id=tsa.teacher_id
      WHERE tsa.school_id=m.school_id AND tsa.subject_id=m.subject_id AND tsa.class_id=m.class_id
        AND tsa.academic_year_id=m.academic_year_id AND (tsa.term_id=m.term_id OR tsa.term_id IS NULL)
        AND COALESCE(tsa.is_active,true)=true
        AND NOT (upper(trim(coalesce(tassign.first_name,''))) IN ('TEACHER','ADMIN') OR upper(trim(coalesce(tassign.last_name,''))) IN ('TEACHER','ADMIN') OR upper(trim(coalesce(tassign.staff_no,''))) IN ('TEACHER','ADMIN','MR.TEACHER','MR. TEACHER'))
      ORDER BY (tsa.term_id IS NOT NULL) DESC,tsa.created_at DESC,tsa.id DESC
      LIMIT 1
    ) tsa ON true
    LEFT JOIN teachers th ON th.id=tsa.teacher_id
    LEFT JOIN teachers th2 ON th2.user_id=m.entered_by AND th2.school_id=m.school_id AND th2.is_active=true
    LEFT JOIN users u2 ON u2.id=m.entered_by AND u2.is_active=true
    WHERE m.school_id=$1 AND m.learner_id=$2 AND m.academic_year_id=$3 AND m.term_id=$4
    ORDER BY s.name,a.assessment_order,a.name`,[schoolId,learnerId,yearId,termId,meta.section_id,meta.level_id])).rows;

  // Subject-teacher assignments are read live for every report build.  This is
  // intentional: an administrator can assign/reassign a teacher and the very next
  // report card must immediately reflect that assignment instead of waiting for a
  // short-lived report cache to expire.
  //
  // Resolution order per subject:
  //   1) assignment for the selected term
  //   2) all-terms assignment
  //   3) another assignment in the same year (latest one)
  // Active assignments are preferred, but an inactive historical row is allowed as a
  // fallback so a valid teacher name is never lost from an existing report.
  const assignedSubjects = (await db.query(`
    SELECT DISTINCT ON (tsa.subject_id) tsa.subject_id,s.code subject_code,s.name subject_name,
           th.staff_no,th.first_name teacher_first_name,th.last_name teacher_last_name,
           COALESCE(tsa.is_active,true) assignment_active,tsa.term_id assignment_term_id,
           tsa.created_at assignment_created_at
    FROM teacher_subject_assignments tsa
    JOIN subjects s ON s.id=tsa.subject_id
    JOIN teachers th ON th.id=tsa.teacher_id
    WHERE tsa.school_id=$1 AND tsa.class_id=$2 AND tsa.academic_year_id=$3
      AND NOT (upper(trim(coalesce(th.first_name,''))) IN ('TEACHER','ADMIN') OR upper(trim(coalesce(th.last_name,''))) IN ('TEACHER','ADMIN') OR upper(trim(coalesce(th.staff_no,''))) IN ('TEACHER','ADMIN','MR.TEACHER','MR. TEACHER'))
    ORDER BY tsa.subject_id,
      CASE WHEN tsa.term_id=$4 THEN 0 WHEN tsa.term_id IS NULL THEN 1 ELSE 2 END,
      CASE WHEN COALESCE(tsa.is_active,true)=true THEN 0 ELSE 1 END,
      tsa.created_at DESC,tsa.id DESC`,[schoolId,meta.class_id,yearId,termId])).rows;

  // Report-card subjects come from the current class assignments PLUS any marks
  // actually recorded for this learner in the selected year/term.  This prevents a
  // valid OPENER mark from disappearing merely because an assignment record was
  // later deactivated or changed.  The assignment remains the authoritative source
  // for the subject teacher name when one exists.
  const subjectIds = [...new Set([
    ...assignedSubjects.map(x=>x.subject_id),
    ...marks.map(x=>x.subject_id)
  ])];
  const marksBySubject=new Map();
  for(const m of marks){if(!marksBySubject.has(m.subject_id))marksBySubject.set(m.subject_id,[]);marksBySubject.get(m.subject_id).push(m);}
  const subjects = [];
  for (const subjectId of subjectIds) {
    const sm = marksBySubject.get(subjectId)||[];
    const assigned = assignedSubjects.find(x=>x.subject_id===subjectId);
    // Official assessment structure: Terms 1–2 use Opener + Mid Term + End Term;
    // Term 3 uses Opener + End Term only. A Term 3 Mid Term is never a report-card
    // column and can never affect the official average.
    const standardTypes = meta.term_no===3 ? new Set(['OPENER','END_TERM']) : new Set(['OPENER','MID_TERM','END_TERM']);
    const examColumns = assessments
      .filter(a=>standardTypes.has(String(a.assessment_type||'').toUpperCase()))
      .sort((a,b)=>Number(a.assessment_order||0)-Number(b.assessment_order||0))
      .map(a=>String(a.assessment_type||'').toUpperCase())
      .filter((v,i,a)=>a.indexOf(v)===i);
    // Always render the school's official columns.  Assessment rows may contain
    // duplicate OPENER/END_TERM records from historical setup changes; for the
    // report card choose the latest non-blank recorded mark for each assessment type.
    const allowedTypes = standardTypes;
    const byType = new Map();
    sm.filter(m=>allowedTypes.has(String(m.assessment_type||'').toUpperCase()))
      .forEach(m=>{
        const type=String(m.assessment_type||'').toUpperCase();
        const current=byType.get(type);
        const markValue=finite(m.mark);
        const currentValue=current?finite(current.mark):null;
        const mTime=Date.parse(m.updated_at||m.created_at||'')||0;
        const cTime=current?Date.parse(current.updated_at||current.created_at||'')||0:-1;
        if(!current || (markValue!==null && currentValue===null) || (markValue!==null && currentValue!==null && mTime>cTime) || (markValue===null && currentValue===null && mTime>cTime)){
          byType.set(type,m);
        }
      });
    const byAssessment = [...byType.values()]
      .sort((a,b)=>{
        const order=Number(a.assessment_order||0)-Number(b.assessment_order||0);
        if(order!==0)return order;
        return String(a.assessment_type||'').localeCompare(String(b.assessment_type||''));
      })
      .map(m=>{
        const max=Number(m.max_mark)||100;
        const raw=finite(m.mark);
        return {...m,percent:raw===null?null:(raw/max)*100};
      });
    const included = byAssessment.filter(m=>m.percent!==null && m.include_in_term_average!==false);
    // Official report-card averaging: Terms 1–2 average the three assessment
    // columns; Term 3 has only OPENER + END TERM. When only OPENER has been
    // entered, OPENER itself is the subject average — it must never remain blank.
    // Assessment weights do not alter the school's standard report-card average.
    const subjectAverage = meta.term_no===3
      ? avg(included.map(m=>m.percent))
      : avg(included.map(m=>m.percent));
    const grading = await resolveGrading(schoolId,meta,included[0]?.assessment_id,subjectId);
    const grade=gradeFor(subjectAverage,grading.bands);
    // The report must show the teacher actually assigned to this subject/class.
    // Prefer the current assignment record over the teacher attached to an old mark.
    const assignedReal = assigned && !isPlaceholderTeacher(assigned) ? assigned : null;
    const markTeacher = sm.find(x=>(x.teacher_first_name||x.teacher_last_name) && !isPlaceholderTeacher({teacher_first_name:x.teacher_first_name,teacher_last_name:x.teacher_last_name,staff_no:x.staff_no}))
      || sm.find(x=>(x.entered_teacher_first_name||x.entered_teacher_last_name) && !isPlaceholderTeacher({teacher_first_name:x.entered_teacher_first_name,teacher_last_name:x.entered_teacher_last_name,staff_no:x.entered_teacher_staff_no}))
      || sm.find(x=>(x.entered_user_first_name||x.entered_user_last_name) && !isPlaceholderTeacher({first_name:x.entered_user_first_name,last_name:x.entered_user_last_name}));
    const teacher = assignedReal || markTeacher;
    const tf=teacher===markTeacher ? (teacher?.teacher_first_name || teacher?.entered_teacher_first_name || teacher?.entered_user_first_name) : teacher?.teacher_first_name;
    const tl=teacher===markTeacher ? (teacher?.teacher_last_name || teacher?.entered_teacher_last_name || teacher?.entered_user_last_name) : teacher?.teacher_last_name;
    const ts=teacher===markTeacher ? (teacher?.staff_no || teacher?.entered_teacher_staff_no) : teacher?.staff_no;
    subjects.push({
      subject_id:subjectId,subject_code:sm[0]?.subject_code||assigned?.subject_code||'',subject_name:sm[0]?.subject_name||assigned?.subject_name||'Subject',
      average:subjectAverage,grade:grade?.label||"",points:grade?.points??"",descriptor:grade?.descriptor||"",remark:grade?.remark||"",
      teacher_initials:teacher?teacherInitials(tf,tl,ts):"",
      teacher_name:teacher?teacherDisplay(tf,tl,ts):'',
      // Keep the subject COMMENT cell available for the teacher.  If a teacher has
      // explicitly saved a subject-level remark with a mark, preserve that remark;
      // otherwise leave the cell blank instead of injecting long automatic prose.
      comment:autoSubjectComment({average:subjectAverage}),
      assessments:byAssessment.map(m=>({id:m.assessment_id,name:m.assessment_name,type:m.assessment_type,mark:m.mark,max_mark:m.max_mark,percent:m.percent,weight:m.weight}))
    });
  }
  subjects.sort((a,b)=>a.subject_name.localeCompare(b.subject_name));
  // Rank this learner in every subject against the selected class, and capture year-on-year deviation.
  const reportAssessmentSql = meta.term_no===3 ? "'OPENER','END_TERM'" : "'OPENER','MID_TERM','END_TERM'";
  const rankRows=(await db.query(`
    WITH standard_marks AS (
      SELECT DISTINCT ON (m.learner_id,m.subject_id,a.assessment_type)
             m.learner_id,m.subject_id,m.mark,a.max_mark,a.created_at,a.id
      FROM marks m
      JOIN assessments a ON a.id=m.assessment_id
      JOIN terms t ON t.id=m.term_id
      WHERE m.school_id=$1 AND m.class_id=$2 AND m.academic_year_id=$3 AND m.term_id=$4
        AND m.mark IS NOT NULL
        AND a.assessment_type IN (${reportAssessmentSql})
        AND EXISTS (
          SELECT 1 FROM teacher_subject_assignments tsa
          WHERE tsa.school_id=m.school_id AND tsa.subject_id=m.subject_id
            AND tsa.class_id=m.class_id AND tsa.academic_year_id=m.academic_year_id
            AND (tsa.term_id=m.term_id OR tsa.term_id IS NULL)
        )
      ORDER BY m.learner_id,m.subject_id,a.assessment_type,a.created_at,a.id
    ),
    per_learner_subject AS (
      SELECT learner_id,subject_id,AVG((mark/NULLIF(max_mark,0))*100.0) average
      FROM standard_marks
      GROUP BY learner_id,subject_id
    )
    SELECT learner_id,subject_id,average,
           DENSE_RANK() OVER(PARTITION BY subject_id ORDER BY average DESC) subject_rank,
           COUNT(*) OVER(PARTITION BY subject_id) subject_learner_count
    FROM per_learner_subject`,[schoolId,meta.class_id,yearId,termId])).rows;
  const currentRanks=new Map(rankRows.filter(r=>r.learner_id===learnerId).map(r=>[r.subject_id,r]));
  const priorRows=(await db.query(`
    WITH latest_terms AS (
      SELECT DISTINCT ON (ay.id) ay.id ay_id,t.id term_id,ay.year_label,t.term_no
      FROM academic_years ay JOIN terms t ON t.academic_year_id=ay.id AND t.school_id=ay.school_id
      WHERE ay.school_id=$1 AND ay.id<>$2 AND t.term_no=$3
      ORDER BY ay.id DESC,t.term_no DESC
    )
    SELECT ay.year_label,m.subject_id,AVG((m.mark/NULLIF(a.max_mark,0))*100.0) average
    FROM latest_terms ay JOIN marks m ON m.academic_year_id=ay.ay_id AND m.term_id=ay.term_id
      JOIN assessments a ON a.id=m.assessment_id
    WHERE m.school_id=$1 AND m.learner_id=$4 AND m.mark IS NOT NULL
      AND a.assessment_type IN (${reportAssessmentSql})
    GROUP BY ay.year_label,m.subject_id`,[schoolId,yearId,meta.term_no,learnerId])).rows;
  const priorBySubject=new Map();for(const r of priorRows){if(!priorBySubject.has(r.subject_id))priorBySubject.set(r.subject_id,[]);priorBySubject.get(r.subject_id).push(r);}
  subjects.forEach(s=>{const rr=currentRanks.get(s.subject_id);const priors=priorBySubject.get(s.subject_id)||[];s.subject_rank=rr?Number(rr.subject_rank):null;s.subject_rank_total=rr?Number(rr.subject_learner_count):null;s.previous_years=priors.map(r=>({year_label:r.year_label,average:Number(r.average)}));const immediate=priors[0];s.previous_year_average=immediate?Number(immediate.average):null;s.previous_year_deviation=(immediate&&s.average!=null)?Number(s.average)-Number(immediate.average):null;});
  const subjectRanking=[...subjects].filter(s=>s.average!==null).sort((a,b)=>b.average-a.average||a.subject_name.localeCompare(b.subject_name)).map((s,i)=>({...s,subject_rank:i+1}));
  const overall=avg(subjects.map(s=>s.average));
  let classTeacher=(await db.query(`SELECT tr.id,tr.first_name,tr.last_name,tr.staff_no,tr.signature_url FROM class_teacher_assignments cta JOIN teachers tr ON tr.id=cta.teacher_id WHERE cta.school_id=$1 AND cta.class_id=$2 AND cta.academic_year_id=$3 AND (cta.term_id=$4 OR cta.term_id IS NULL) AND tr.is_active=true AND upper(trim(coalesce(tr.last_name,'')))<>'TEACHER' ORDER BY (cta.term_id IS NOT NULL) DESC,cta.created_at DESC LIMIT 1`,[schoolId,meta.class_id,yearId,termId])).rows[0];
  if(!classTeacher) classTeacher=(await db.query(`SELECT tr.id,tr.first_name,tr.last_name,tr.staff_no,tr.signature_url FROM teacher_subject_assignments tsa JOIN teachers tr ON tr.id=tsa.teacher_id WHERE tsa.school_id=$1 AND tsa.class_id=$2 AND tsa.academic_year_id=$3 AND (tsa.term_id=$4 OR tsa.term_id IS NULL) AND COALESCE(tsa.is_class_teacher,false)=true AND tr.is_active=true AND upper(trim(coalesce(tr.last_name,'')))<>'TEACHER' ORDER BY (tsa.term_id IS NOT NULL) DESC,tsa.created_at DESC,tsa.id DESC LIMIT 1`,[schoolId,meta.class_id,yearId,termId])).rows[0];
  if(!classTeacher) classTeacher=(await db.query(`SELECT tr.id,tr.first_name,tr.last_name,tr.staff_no,tr.signature_url FROM teachers tr JOIN user_school_roles usr ON usr.user_id=tr.user_id AND usr.school_id=tr.school_id WHERE tr.school_id=$1 AND usr.role='CLASS_TEACHER' AND tr.is_active=true AND upper(trim(coalesce(tr.last_name,'')))<>'TEACHER' ORDER BY tr.last_name,tr.first_name LIMIT 1`,[schoolId])).rows[0];
  let headTeacher=(await db.query(`SELECT tr.id,tr.first_name,tr.last_name,tr.staff_no,tr.signature_url FROM teachers tr JOIN user_school_roles usr ON usr.user_id=tr.user_id AND usr.school_id=tr.school_id WHERE tr.school_id=$1 AND usr.role='HEADTEACHER' AND tr.is_active=true AND upper(trim(coalesce(tr.last_name,'')))<>'TEACHER' ORDER BY tr.last_name,tr.first_name LIMIT 1`,[schoolId])).rows[0];
  if(!headTeacher) headTeacher=(await db.query(`SELECT tr.id,tr.first_name,tr.last_name,tr.staff_no,tr.signature_url FROM teachers tr JOIN user_school_roles usr ON usr.user_id=tr.user_id AND usr.school_id=tr.school_id WHERE tr.school_id=$1 AND usr.role IN ('SCHOOL_ADMIN','HEADTEACHER') AND tr.is_active=true AND upper(trim(coalesce(tr.last_name,'')))<>'TEACHER' ORDER BY CASE WHEN usr.role='HEADTEACHER' THEN 0 ELSE 1 END,tr.last_name,tr.first_name LIMIT 1`,[schoolId])).rows[0];
  const stamp=(await db.query(`SELECT file_url FROM school_document_assets WHERE school_id=$1 AND asset_type='STAMP' AND is_active=true AND effective_from<=COALESCE((SELECT opening_date FROM terms WHERE id=$2),CURRENT_DATE) AND (effective_to IS NULL OR effective_to>=COALESCE((SELECT opening_date FROM terms WHERE id=$2),CURRENT_DATE)) ORDER BY effective_from DESC,created_at DESC LIMIT 1`,[schoolId,termId])).rows[0];
  const overallGrading=await resolveGrading(schoolId,meta,null,null);
  const overallGrade=gradeFor(overall,overallGrading.bands);
  const sorted=[...subjects].filter(s=>s.average!==null).sort((a,b)=>b.average-a.average);
  const strongest=sorted[0], weakest=sorted[sorted.length-1];
  const trend=subjects.flatMap(s=>s.assessments.filter(a=>a.percent!==null).map(a=>a.percent));
  const trendAvg=avg(trend);
  const trendText=trendAvg===null?"": overall!==null && trendAvg<overall-5?"The learner shows stronger performance in the current subject averages than in the assessment history.":"Assessment performance is generally consistent with the current subject averages.";
  const classRemark=overall===null?"No overall performance can be calculated yet.":overall>=80?`Outstanding overall performance, with particular strength in ${strongest?.subject_name||"the leading learning area"}. Continue the excellent work.`:overall>=70?`Very good overall performance. Strongest area: ${strongest?.subject_name||"the leading learning area"}. Keep building consistency.`:overall>=50?`A positive overall performance. Continued effort, especially in ${weakest?.subject_name||"the area needing most support"}, should improve results further.`:`Additional academic support is recommended, especially in ${weakest?.subject_name||"the area needing most support"}.`;
  const headRemark=overall===null?"Performance will be reviewed once sufficient assessment data is available.":overall>=80?"Commendable performance. The learner should maintain the current standard and continue aiming higher.":overall>=70?"Good performance. Maintain steady effort and continue strengthening weaker areas.":overall>=50?"The learner is making positive progress. Continued monitoring and targeted support are recommended.":"The learner requires closer academic support, monitoring and a consistent improvement plan.";
  let designationRecord=null;
  try {
    designationRecord=(await db.query(`SELECT designation,decision,attendance_days,school_open_days,conduct,effort,next_term_target,intervention_plan,teacher_comment,headteacher_comment
      FROM report_card_designations
      WHERE school_id=$1 AND learner_id=$2 AND academic_year_id=$3 AND term_id=$4`,[schoolId,learnerId,yearId,termId])).rows[0]||null;
  } catch (_) { /* Migration may not have been applied yet; reports remain operational. */ }
  const designation=(designationRecord?.designation&&designationRecord.designation!=='AUTO')?designationRecord.designation:autoDesignation(overall);
  const progressionDecision=(designationRecord?.decision&&designationRecord.decision!=='AUTO')?designationRecord.decision:autoDecision(overall);

  return {
    ...meta,
    class_teacher:classTeacher?teacherDisplay(classTeacher.first_name,classTeacher.last_name,classTeacher.staff_no):"",
    class_teacher_initials:classTeacher?teacherInitials(classTeacher.first_name,classTeacher.last_name,classTeacher.staff_no):"",
    class_teacher_staff_no:classTeacher?.staff_no||"",
    class_teacher_signature_url:classTeacher?.signature_url||null,
    head_teacher:headTeacher?teacherDisplay(headTeacher.first_name,headTeacher.last_name,headTeacher.staff_no):"",
    head_teacher_staff_no:headTeacher?.staff_no||"",
    head_teacher_signature_url:headTeacher?.signature_url||null,
    stamp_url:stamp?.file_url||null,
    learner_name:[meta.first_name,meta.middle_name,meta.last_name].filter(Boolean).join(" "),
    subjects,
    subject_ranking:subjectRanking,
    overall_subject_rank: overall===null?null:((await db.query(`SELECT COUNT(*)+1 AS rank FROM (SELECT l.id,AVG(m.mark/NULLIF(a.max_mark,0)*100.0) average FROM learners l JOIN marks m ON m.learner_id=l.id JOIN assessments a ON a.id=m.assessment_id WHERE l.school_id=$1 AND m.class_id=$2 AND m.academic_year_id=$3 AND m.term_id=$4 AND m.mark IS NOT NULL GROUP BY l.id) z WHERE z.average>$5`,[schoolId,meta.class_id,yearId,termId,overall])).rows[0]?.rank||1),
    previous_year_deviations: [...new Map(priorRows.map(p=>p.year_label)).values()].map(year_label=>{const vals=subjects.flatMap(s=>(s.previous_years||[]).filter(p=>p.year_label===year_label).map(p=>({current:s.average,previous:p.average}))).filter(x=>x.current!=null);return {year_label,deviation:vals.length?vals.reduce((a,x)=>a+(x.current-x.previous),0)/vals.length:null};}).filter(x=>x.deviation!=null).sort((a,b)=>String(b.year_label).localeCompare(String(a.year_label))),
    assessments,
    exam_columns: (assessments||[])
      .filter(a=>{const type=String(a.assessment_type||'').toUpperCase();return (meta.term_no===3?['OPENER','END_TERM']:['OPENER','MID_TERM','END_TERM']).includes(type);})
      .sort((a,b)=>Number(a.assessment_order||0)-Number(b.assessment_order||0))
      .map(a=>({type:String(a.assessment_type||'').toUpperCase(),name:a.name}))
      .filter((v,i,a)=>a.findIndex(x=>x.type===v.type)===i),
    overall_average:overall,
    overall_grade:overallGrade?.label||"",
    overall_points:overallGrade?.points??"",
    grading_system:overallGrading.system,
    grading_bands:overallGrading.bands,
    class_teacher_remark:classRemark,
    head_teacher_remark:headRemark,
    assessment_trend_remark:trendText,
    strongest_subject:strongest?.subject_name||"",
    weakest_subject:weakest?.subject_name||"",
    designation,
    progression_decision:progressionDecision,
    attendance_days:designationRecord?.attendance_days??null,
    school_open_days:designationRecord?.school_open_days??null,
    conduct:designationRecord?.conduct||'',
    effort:designationRecord?.effort||'',
    next_term_target:designationRecord?.next_term_target??null,
    intervention_plan:designationRecord?.intervention_plan||'',
    recorded_teacher_comment:designationRecord?.teacher_comment||'',
    recorded_headteacher_comment:designationRecord?.headteacher_comment||'',
    identity_snapshot:meta.identity_snapshot||{}
  };
}

async function buildYearReport(schoolId,learnerId,yearId) {
  const terms=(await db.query(`SELECT id,term_no,name FROM terms WHERE school_id=$1 AND academic_year_id=$2 ORDER BY term_no`,[schoolId,yearId])).rows;
  const reports=[];
  for(const t of terms){ const r=await buildTermReport(schoolId,learnerId,yearId,t.id); if(r) reports.push(r); }
  if(!reports.length) return null;
  const subjectMap=new Map();
  reports.forEach(r=>r.subjects.forEach(s=>{
    if(!subjectMap.has(s.subject_id)) subjectMap.set(s.subject_id,{...s,terms:{}});
    subjectMap.get(s.subject_id).terms[r.term_no]=s.average;
  }));
  const subjects=[...subjectMap.values()].map(s=>({...s,annual_average:avg(Object.values(s.terms))}));
  const annualOverall=avg(subjects.map(s=>s.annual_average));
  const grading=await resolveGrading(schoolId,reports[0],null,null);
  const g=gradeFor(annualOverall,grading.bands);
  return {...reports[0],subjects,term_reports:reports,overall_average:annualOverall,overall_grade:g?.label||"",overall_points:g?.points??"",grading_system:grading.system,grading_bands:grading.bands};
}

module.exports={buildTermReport,buildYearReport,avg,gradeFor,autoDesignation,autoDecision};
