const PDFDocument=require('pdfkit');
const fs=require('fs'),path=require('path');
const {source:assetSource}=require('./assets');
const {PDFDocument:PDFLibDocument}=require('pdf-lib');
const safe=s=>String(s??'').replace(/[<>]/g,'');
function assetPath(url){return assetSource(url);}
function normalizeReport(input){
  const r=(input&&typeof input==='object')?input:{};
  return {
    ...r,
    subjects:(Array.isArray(r.subjects)?r.subjects:[]).map(s=>({
      ...s,
      terms:(s&&s.terms&&typeof s.terms==='object')?s.terms:{},
      assessments:Array.isArray(s?.assessments)?s.assessments:[]
    })),
    term_reports:Array.isArray(r.term_reports)?r.term_reports.filter(Boolean):[],
    exam_columns:Array.isArray(r.exam_columns)?r.exam_columns:[],
    grading_bands:Array.isArray(r.grading_bands)?r.grading_bands:[],
    subject_ranking:Array.isArray(r.subject_ranking)?r.subject_ranking:[]
  };
}
function hex(c,fallback){const v=String(c||'').toUpperCase();if(v==='#17365D')return '#0B4F8A';if(v==='#D9A441')return '#16A36A';return /^#[0-9A-F]{6}$/i.test(v)?v:fallback;}
function rounded(doc,x,y,w,h,r,fill,stroke){if(fill)doc.fillColor(fill).roundedRect(x,y,w,h,r).fill();if(stroke)doc.strokeColor(stroke).lineWidth(.95).roundedRect(x,y,w,h,r).stroke();}
function text(doc,t,x,y,w,size,bold,color,align='left',opts={}){doc.fillColor(color||'#222').font(bold?'Helvetica-Bold':'Helvetica').fontSize(size||7).text(safe(t),x,y,{width:w,align,lineGap:0,ellipsis:!!opts.ellipsis,height:opts.height,lineBreak:opts.lineBreak!==false});}
function line(doc,x1,y1,x2,y2,c='#111111',lw=.9){doc.save().strokeColor(c).lineWidth(lw).moveTo(x1,y1).lineTo(x2,y2).stroke().restore();}
function stars(doc,x,y,w,h,color){doc.save().strokeColor(color).lineWidth(1.25).roundedRect(x,y,w,h,7).stroke();doc.font('Helvetica-Bold').fontSize(7).fillColor(color);for(let xx=x+7;xx<x+w-5;xx+=15){doc.text('★',xx,y-1,{width:9});doc.text('★',xx,y+h-8,{width:9});}for(let yy=y+12;yy<y+h-8;yy+=15){doc.text('★',x-2,yy,{width:9});doc.text('★',x+w-5,yy,{width:9});}doc.restore();}
function drawLogo(doc,url,cx,y,size){const p=assetPath(url);if(!p)return false;try{doc.image(p,cx-size/2,y,{fit:[size,size],align:'center',valign:'center'});return true;}catch{return false;}}
function drawWatermark(doc,url,cx,cy,size,opacity=.075){const p=assetPath(url);if(!p)return false;try{doc.save().opacity(opacity);doc.image(p,cx-size/2,cy-size/2,{fit:[size,size],align:'center',valign:'center'});doc.restore();return true;}catch{try{doc.restore();}catch{}return false;}}
function drawTextWatermark(doc,name,motto,cx,cy,width,opacity=.045){const title=String(name||'').trim();if(!title)return false;try{doc.save().opacity(opacity).fillColor('#334155').font('Helvetica-Bold').fontSize(34).text(title,cx-width/2,cy-20,{width,align:'center',lineBreak:false,ellipsis:true});if(motto){doc.font('Helvetica').fontSize(13).text(String(motto),cx-width/2,cy+22,{width,align:'center',lineBreak:false,ellipsis:true});}doc.restore();return true;}catch{try{doc.restore();}catch{}return false;}}
function drawPhoto(doc,url,x,y,w,h,border){const p=assetPath(url);rounded(doc,x,y,w,h,4,'#F1F4F7',border);if(p){try{doc.image(p,x+3,y+3,{fit:[w-6,h-6],align:'center',valign:'center'});}catch{}}else{text(doc,'PASSPORT',x,y+h/2-4,w,6,true,'#94a3b8','center');}}
function fmt(v){const n=Number(v);return Number.isFinite(n)?(Math.abs(n-Math.round(n))<0.00001?String(Math.round(n)):n.toFixed(2).replace(/0+$/,'').replace(/\.$/,'')):'—';}
function fmtDate(v){if(!v)return '—';const d=v instanceof Date?v:new Date(v);if(Number.isNaN(d.getTime()))return String(v).replace(/\s+GMT.*$/,'');return `${String(d.getUTCDate()).padStart(2,'0')} ${d.toLocaleString('en-GB',{month:'short',timeZone:'UTC'})} ${d.getUTCFullYear()}`;}
function gradeColor(g){const s=String(g||'').toUpperCase();if(['EE','A','A+'].includes(s))return '#15803d';if(['ME','B','B+','B-'].includes(s))return '#2563eb';if(['AE','C','C+','C-'].includes(s))return '#d97706';if(['BE','D','D-','E'].includes(s))return '#dc2626';return '#26384A';}
function designationColor(d){const s=String(d||'').toUpperCase();if(s==='DISTINCTION')return '#15803d';if(['MERIT','CREDIT'].includes(s))return '#2563eb';if(s==='PASS')return '#d97706';if(['AT_RISK','INCOMPLETE'].includes(s))return '#dc2626';return '#6b7280';}
function drawMiniTrend(doc,values,x,y,w,h,primary,label){text(doc,label,x,y-11,w,6.5,true,primary);rounded(doc,x,y,w,h,5,'#F1F4F7','#111111');const vals=values.filter(v=>v!=null).map(Number);if(!vals.length){text(doc,'No assessed marks yet',x+5,y+h/2-3,w-10,6,false,'#94a3b8','center');return;}const pts=vals.map((v,i)=>{const px=x+12+(w-24)*(i/Math.max(1,vals.length-1));const py=y+h-11-(Math.max(0,Math.min(100,v))/100)*(h-22);return [px,py];});for(let i=1;i<pts.length;i++)line(doc,pts[i-1][0],pts[i-1][1],pts[i][0],pts[i][1],primary,1.4);pts.forEach((p,i)=>{doc.save().fillColor(primary).circle(p[0],p[1],2.2).fill();doc.restore();text(doc,String(Math.round(vals[i])),p[0]-8,p[1]-10,16,4.4,true,primary,'center');});}
function drawSubjectTrend(doc,report,x,y,w,h,primary,label){
 text(doc,label,x,y-11,w,6.5,true,primary); rounded(doc,x,y,w,h,5,'#F8FAFC','#111111');
 const subjects=(report.subjects||[]).filter(s=>s && (report.term_reports ? Object.values(s.terms||{}).some(v=>v!=null) : (s.assessments||[]).some(a=>a.percent!=null))).slice(0,10);
 if(!subjects.length){text(doc,'No subject trend data yet',x+5,y+h/2-3,w-10,6,false,'#94a3b8','center');return;}
 const palette=['#2563EB','#DC2626','#059669','#D97706','#7C3AED','#DB2777','#0891B2','#65A30D','#EA580C','#4F46E5'];
 const labels=report.term_reports?['TERM 1','TERM 2','TERM 3']:((report.exam_columns||[]).map(a=>a.name||a.type));
 const left=35,right=12,top=18,bottom=20,cw=Math.max(1,w-left-right),ch=Math.max(1,h-top-bottom);
 [0,25,50,75,100].forEach(v=>{const py=y+top+ch-(v/100)*ch;line(doc,x+left,py,x+w-right,py,'#D9E1E8',.55);text(doc,String(v),x+3,py-2,27,4.2,false,'#64748B','right');});
 labels.forEach((lab,i)=>{const px=x+left+cw*(i/Math.max(1,labels.length-1));text(doc,lab,px-25,y+h-13,50,4.1,false,'#475569','center',{ellipsis:true,height:8,lineBreak:false});});
 subjects.forEach((sub,si)=>{
   const vals=report.term_reports ? labels.map((_,i)=>sub.terms?.[i+1]??null) : labels.map(lab=>{const a=(sub.assessments||[]).find(a=>String(a.name||a.type)===String(lab));return a?.percent??null;});
   const pts=vals.map((v,i)=>v==null?null:[x+left+cw*(i/Math.max(1,labels.length-1)),y+top+ch-(Math.max(0,Math.min(100,Number(v)))/100)*ch]).filter(Boolean);
   for(let i=1;i<pts.length;i++)line(doc,pts[i-1][0],pts[i-1][1],pts[i][0],pts[i][1],palette[si%palette.length],1.45);
   pts.forEach(pt=>{doc.save().fillColor(palette[si%palette.length]).circle(pt[0],pt[1],2).fill();doc.restore();});
   const ly=y+3+Math.floor(si/3)*8,lx=x+8+(si%3)*(w-16)/3;doc.save().fillColor(palette[si%palette.length]).rect(lx,ly,5,2).fill();doc.restore();text(doc,String(sub.subject_name||'Subject').slice(0,16),lx+7,ly-2,(w-16)/3-10,4.0,false,'#334155','left',{ellipsis:true,height:7,lineBreak:false});
 });
}
function drawSubjectBars(doc,subjects,x,y,w,h,primary,label){
 text(doc,label,x,y-11,w,6.5,true,primary);
 rounded(doc,x,y,w,h,5,'#F8FAFC','#111111');
 const vals=(subjects||[]).filter(s=>s.average!=null||s.annual_average!=null).slice().sort((a,b)=>Number(b.average??b.annual_average)-Number(a.average??a.annual_average)).slice(0,6);
 if(!vals.length){text(doc,'No assessed marks yet',x+5,y+h/2-3,w-10,6,false,'#94a3b8','center');return;}
 const max=Math.max(100,...vals.map(s=>Number(s.average??s.annual_average)||0));
 const rowH=Math.min(10,(h-16)/vals.length);
 vals.forEach((s,i)=>{
   const v=Number(s.average??s.annual_average)||0, yy=y+7+i*rowH;
   text(doc,String(s.subject_name||'Subject').slice(0,18),x+5,yy,w*0.43,4.4,true,'#334155','left',{ellipsis:true,height:rowH,lineBreak:false});
   const bx=x+w*0.45,bw=w*0.42;
   rounded(doc,bx,yy+1,bw,Math.max(4,rowH-3),2,'#E7EDF3',null);
   rounded(doc,bx,yy+1,bw*Math.max(0,Math.min(100,v))/max,Math.max(4,rowH-3),2,primary,null);
   text(doc,fmt(v),bx+bw+3,yy,w-bw-(bx-x)-7,4.4,true,primary,'right');
 });
}
function drawGrading(doc,bands,x,y,w,h,primary){text(doc,'GRADING SCALE',x,y,w,5.8,true,primary);rounded(doc,x,y+10,w,h-10,4,'#fff','#111111');const bs=(bands||[]).slice().sort((a,b)=>Number(b.min_mark)-Number(a.min_mark));if(!bs.length){text(doc,'Configured grading system',x+5,y+24,w-10,5.5,false,'#1F3347','center');return;}const rh=Math.min(10,(h-12)/bs.length);bs.forEach((b,i)=>{const yy=y+11+i*rh;if(i%2===0){doc.save().fillColor('#F1F4F7').rect(x+1,yy,w-2,rh).fill().restore();}text(doc,`${b.min_mark}–${b.max_mark}`,x+4,yy+1,52,4.7,false,'#1F3347');text(doc,b.label,x+59,yy+1,28,4.8,true,gradeColor(b.label),'center');text(doc,b.descriptor||b.remark||'',x+91,yy+1,w-96,4.6,false,'#26384A');});}
function fitRows(n,available,min,max){return Math.max(min,Math.min(max,Math.floor(available/Math.max(1,n))));}
function drawReportPage(doc,report){
 const primary=hex(report.primary_color,'#12355B'),accent=hex(report.secondary_color,'#B8860B');
 const pageW=595,pageH=842,x=28,w=539,bottom=818;
 // Clean, conventional school report-card layout. Everything is deliberately kept on one A4 page.
 rounded(doc,12,12,pageW-24,pageH-24,6,'#fff','#111111');
 // Formal double school-document frame: simple black outer + inner rules only.
 doc.save().strokeColor('#111111').lineWidth(2.2).rect(10,10,pageW-20,pageH-20).stroke().restore();
 doc.save().strokeColor('#111111').lineWidth(1.1).rect(17,17,pageW-34,pageH-34).stroke().restore();
 // Security-style PRO-MARK watermark: subtle, centered, and behind report content.
 if(report.watermark_enabled!==false){if(!drawWatermark(doc,report.logo_url,pageW/2,pageH/2,300,.045))drawTextWatermark(doc,report.school_name,report.motto,pageW/2,pageH/2,420,.035);}
 // Header hierarchy: address/contact above the centered school logo, followed by the school title.
 if(report.logo_url)drawLogo(doc,report.logo_url,pageW/2,34,64);
 text(doc,report.school_name||'SCHOOL',x,102,w,16,true,primary,'center');
 text(doc,report.address||'',x,121,w,6,false,'#334155','center');
 text(doc,report.motto||'',x,132,w,6,false,'#334155','center');
 // School phone belongs directly below the motto, as required for school identity.
 const headerContact=[report.contact_phone].filter(Boolean).join('  |  ');
 if(headerContact)text(doc,headerContact,x,141,w,5.4,false,'#374151','center');
 line(doc,x,151,x+w,151,'#111111',.8);
 text(doc,report.term_reports?'ANNUAL ACADEMIC REPORT':'ACADEMIC REPORT CARD',x,158,w,10.5,true,primary,'center');
 text(doc,`ACADEMIC YEAR ${safe(report.year_label)}${report.term_reports?'':'  •  '+safe(report.term_name||'TERM')}`,x,172,w,5.8,true,'#334155','center');

 // Learner identity block
 const iy=185,ih=58;
 rounded(doc,x,iy,w,ih,5,'#F8FAFC','#111111');
 drawPhoto(doc,report.passport_photo_url,x+7,iy+6,46,46,accent);
 text(doc,'LEARNER',x+62,iy+8,48,5.3,true,primary);
 text(doc,report.learner_name||'—',x+112,iy+7,190,9,true,'#0F172A');
 text(doc,'CLASS / STREAM',x+315,iy+8,70,5.3,true,primary);
 text(doc,`${report.class_name||'—'}${report.stream?' / '+report.stream:''}`,x+388,iy+7,165-28,7,true,'#0F172A');
 text(doc,'ADM. NO.',x+62,iy+30,66,5.3,true,primary);
 text(doc,report.admission_no||'—',x+130,iy+29,82,6,false,'#334155');
 text(doc,'ASSES. NO.',x+220,iy+30,76,5.3,true,primary);
 text(doc,report.assessment_no||'—',x+299,iy+29,78,6,false,'#334155');
 text(doc,'LEVEL',x+388,iy+30,35,5.3,true,primary);
 text(doc,report.level_name||'—',x+428,iy+29,100,6,false,'#334155');
 text(doc,'TERM DATES',x+62,iy+45,60,5.3,true,primary);
 text(doc,`${fmtDate(report.opening_date)} – ${fmtDate(report.closing_date)}`,x+125,iy+44,220,5.3,false,'#334155');
 text(doc,'SCHOOL CALENDAR',x+348,iy+45,70,5.3,true,primary);
 text(doc,(report.reopening_date||report.next_term_opening_date)?`Reopens: ${fmtDate(report.reopening_date||report.next_term_opening_date)}`:'Reopening date: —',x+420,iy+44,125,5.1,false,'#334155');

 let y=240;
 if(report.term_reports){
   text(doc,'ANNUAL SUBJECT PERFORMANCE',x,y,w,6.5,true,primary);y+=9;
   const c=[x,x+175,x+230,x+285,x+340,x+385,x+438,x+w];
   const heads=['SUBJECT / LEARNING AREA','TERM 1','TERM 2','TERM 3','ANNUAL','GRADE','RANK'];
   rounded(doc,x,y,w,18,2,primary);
   heads.forEach((h,i)=>text(doc,h,c[i]+2,y+5,c[i+1]-c[i]-4,4.4,true,'#fff','center'));
   y+=18;
   const rows=report.subjects||[],rh=fitRows(rows.length,176,10,15);
   rows.forEach((s,i)=>{
     if(i%2===0)doc.save().fillColor('#F8FAFC').rect(x,y,w,rh).fill().restore();
     doc.strokeColor('#111111').lineWidth(.9).rect(x,y,w,rh).stroke();
     text(doc,s.subject_name||'Subject',x+4,y+3,167,4.8,true,'#1E293B','left',{ellipsis:true,height:rh,lineBreak:false});
     [1,2,3].forEach((tn,j)=>text(doc,s.terms?.[tn]==null?'':fmt(s.terms[tn]),c[j+1]+2,y+3,51,4.7,false,'#334155','center'));
     text(doc,s.annual_average==null?'':fmt(s.annual_average),c[4]+2,y+3,41,4.8,true,'#0F172A','center');
     text(doc,s.grade||'',c[5]+2,y+2,43,4.8,true,gradeColor(s.grade),'center');
     text(doc,s.subject_rank==null?'':String(s.subject_rank),c[6]+2,y+3,51,4.7,true,primary,'center');
     y+=rh;
   });
 } else {
   // Give the report-table title its own clear band. The previous underline sat
   // too close to the title and could visually cut through the heading when PDF
   // text metrics differed between viewers.
   rounded(doc,x,y-2,w,21,3,'#F8FAFC','#111111');
   text(doc,'SUBJECT PERFORMANCE AND TEACHER FEEDBACK',x+8,y+4,w-16,7.2,true,primary,'left',{height:11,lineBreak:false,ellipsis:true});
   y+=25;
   // Build the exam columns from the assessments configured by the administrator.
   // There is intentionally no Term 3 special-case here: 2 configured main exams
   // produce 2 exam columns; 3 configured main exams produce 3 exam columns.
   const configured=(report.exam_columns||[])
     .filter(a=>['OPENER','MID_TERM','END_TERM'].includes(String(a.type||'').toUpperCase()))
     .map(a=>({type:String(a.type||'').toUpperCase(),label:`${String(a.name||a.type||'').toUpperCase()}\n(OUT OF ${Number(a.max_mark)||100})`}));
   const standard=configured;
   if(!standard.length){text(doc,'NO MAIN ASSESSMENTS CONFIGURED FOR THIS CLASS / TERM',x,y,w,5.8,true,'#991B1B','center');y+=12;}
   // REPORT-CARD MASTER TABLE
   // The order is fixed and every item has its own physical cell:
   // SUBJECT | OPENER | [MID TERM] | END TERM | AVERAGE | GRADE | TEACHER | COMMENT
   // Never derive the teacher position from text length or from the database columns.
   // This prevents the teacher name from ever being drawn over the GRADE cell.
   const columns=[
     {key:'subject',label:'SUBJECT',width:92,align:'left'},
     ...standard.map(ec=>({key:ec.type,label:ec.label,width:43,align:'center'})),
     {key:'average',label:'AVERAGE',width:45,align:'center'},
     {key:'grade',label:'GRADE',width:45,align:'center'},
     {key:'teacher',label:'TEACHER',width:104,align:'center'},
     {key:'comment',label:'COMMENT',width:167,align:'left'}
   ];
   // Reconcile the final column to the exact printable width so no rounding can
   // create a hidden/overlapping column at the right edge of the A4 page.
   const widthSum=columns.reduce((n,col)=>n+col.width,0);
   columns[columns.length-1].width += (w-widthSum);
   const c=[x];
   columns.forEach(col=>c.push(c[c.length-1]+col.width));

   rounded(doc,x,y,w,25,2,primary);
   columns.forEach((col,i)=>{
     const xx=c[i],cw=col.width;
     text(doc,col.label,xx+2,y+(col.key==='subject'?5:3),cw-4,col.key==='comment'||col.key==='teacher'?4.7:4.4,true,'#fff',col.align==='left'?'left':'center',{height:20,lineBreak:col.key!=='subject'&&col.key!=='comment'&&col.key!=='teacher',ellipsis:true});
     if(i<columns.length-1)line(doc,c[i+1],y,c[i+1],y+25,'#FFFFFF',1);
   });
   y+=25;
   const rows=report.subjects||[];
   // Keep the complete table inside the A4 body while preserving a usable teacher
   // and automatic-comment column. The minimum row height prevents text collision.
   // A4-safe: allocate only the physical space available before the summary.
   // Many subjects must shrink their row height instead of flowing beyond the page.
   const availableTableHeight=Math.max(110, 482-y);
   const rh=rows.length?Math.max(5.2,Math.min(22,availableTableHeight/rows.length)):22;
   rows.forEach((s,i)=>{
     if(i%2===0)doc.save().fillColor('#FBFCFD').rect(x,y,w,rh).fill().restore();
     // Draw each cell independently. This is the visual guarantee that all eight
     // possible columns (seven in Term 3) remain present and separated.
     columns.forEach((col,ci)=>{
       doc.save().strokeColor('#111111').lineWidth(.9).rect(c[ci],y,col.width,rh).stroke().restore();
     });

     const as=s.assessments||[];
     const find=(type)=>as.find(v=>String(v.type||'').toUpperCase()===type);
     const teacher=(s.teacher_name||'').trim();
     const initials=(s.teacher_initials||'').trim();
     const teacherLabel=teacher && initials ? `${teacher}\n(${initials})` : (teacher || initials || '');

     const values={
       subject:s.subject_name||'Subject',
       average:s.average==null?'':fmt(s.average),
       grade:s.grade||'',
       teacher:teacherLabel,
       comment:s.comment||''
     };
     standard.forEach(ec=>{const a=find(ec.type);values[ec.type]=a?.mark==null?'':fmt(a.mark);});

     columns.forEach((col,ci)=>{
       const xx=c[ci],cw=col.width;
       let value=values[col.key]??'';
       if(col.key==='teacher'){
         // Teacher is deliberately confined to the teacher cell. Two short lines
         // (name + initials) are used rather than allowing the text to flow across
         // the neighbouring GRADE/COMMENT cells.
         text(doc,value,xx+3,y+Math.max(2,(rh-7)/2),cw-6,Math.max(3.5,Math.min(4.6,rh-3)),true,'#334155','center',{height:Math.max(3,rh-2),lineBreak:true,ellipsis:true});
       }else if(col.key==='comment'){
         text(doc,value,xx+5,y+Math.max(2,(rh-8)/2),cw-10,Math.max(3.5,Math.min(4.8,rh-3)),false,'#334155','left',{height:Math.max(3,rh-2),lineBreak:true,ellipsis:true});
       }else if(col.key==='subject'){
         text(doc,value,xx+4,y+Math.max(2,(rh-9)/2),cw-8,Math.max(4,Math.min(5.8,rh-2)),true,'#111827','left',{height:Math.max(3,rh-2),lineBreak:false,ellipsis:true});
       }else{
         text(doc,value,xx+2,y+Math.max(2,(rh-9)/2),cw-4,Math.max(4,col.key==='grade'?Math.min(6,rh-2):Math.min(5.5,rh-2)),true,col.key==='grade'?gradeColor(s.grade):'#1F2937','center',{height:Math.max(3,rh-2),lineBreak:false,ellipsis:true});
       }
     });
     y+=rh;
   });
 }
 // Overall summary
 y+=7;
 const cardW=(w-30)/6, cards=[
   ['TOTAL MARKS',report.overall_total_marks==null?'—':`${fmt(report.overall_total_marks)} / ${fmt(report.overall_total_marks_possible||0)}`],
   ['OVERALL AVERAGE',report.overall_average==null?'—':fmt(report.overall_average)],
   ['OVERALL GRADE',report.overall_grade||'—'],
   ['STREAM RANK',report.stream_rank==null?'—':`${report.stream_rank}${report.stream_rank_total?` / ${report.stream_rank_total}`:''}`],
   ['CLASS RANK',report.overall_class_rank==null?'—':`${report.overall_class_rank}${report.class_rank_total?` / ${report.class_rank_total}`:''}`],
   ['DESIGNATION',String(report.designation||'—').replace(/_/g,' ')]
 ];
 cards.forEach((a,i)=>{const xx=x+i*(cardW+6),highlight=i===1?gradeColor(a[1]):i===3?designationColor(a[1]):null;rounded(doc,xx,y,cardW,34,4,highlight||'#F8FAFC',highlight||'#111111');text(doc,a[0],xx+4,y+5,cardW-8,4.0,true,highlight?'#fff':primary,'center');text(doc,a[1],xx+4,y+17,cardW-8,i===4?5.7:8,true,highlight?'#fff':'#0F172A','center');});
 y+=42;

 // Explicitly show the grading system actually assigned to this learner/class.
 // This is the same resolved grading used to calculate the displayed grades.
 if(report.grading_system){
   const gs=report.grading_system;
   text(doc,`GRADING USED: ${String(gs.name||'Configured grading system').toUpperCase()}${gs.code?` (${gs.code})`:''}`,x,y,w,5.8,true,primary,'left');
   y+=9;
   drawGrading(doc,report.grading_bands||[],x,y,w,54,primary);
   y+=62;
 }

 // Pivotal visual performance graphs retained on the report card.
 const graphW=(w-8)/2, graphH=78;
 if(y+graphH+10<760){
   drawSubjectTrend(doc,report,x,y+10,graphW,graphH,primary,'SUBJECT TREND — COMPARATIVE LINES');
   drawSubjectBars(doc,report.subjects||[],x+graphW+8,y+10,graphW,graphH,primary,'SUBJECT PERFORMANCE');
   y+=graphH+20;
 }

 // Remarks are generated from actual performance when teacher remarks were not recorded.
 const rw=(w-8)/2, rh=50;
 rounded(doc,x,y,rw,rh,4,'#fff','#111111');rounded(doc,x+rw+8,y,rw,rh,4,'#fff','#111111');
 text(doc,"CLASS TEACHER'S REMARK",x+7,y+6,rw-14,4.7,true,primary);
 text(doc,report.recorded_teacher_comment||report.class_teacher_remark||'—',x+7,y+17,rw-14,5,false,'#334155','left',{height:29,lineBreak:true});
 text(doc,"HEAD TEACHER'S REMARK",x+rw+15,y+6,rw-14,4.7,true,primary);
 text(doc,report.recorded_headteacher_comment||report.head_teacher_remark||'—',x+rw+15,y+17,rw-14,5,false,'#334155','left',{height:29,lineBreak:true});
 y+=66;

 // Compact designation, attendance and learner-support record.
 const dy=y, dh=34;
 rounded(doc,x,dy,w,dh,4,'#F8FAFC','#111111');
 text(doc,'REPORT CARD DESIGNATION',x+7,dy+5,115,4.5,true,primary);
 text(doc,String(report.designation||'—').replace(/_/g,' '),x+7,dy+15,115,6.5,true,designationColor(report.designation));
 text(doc,'PROGRESSION DECISION',x+128,dy+5,104,4.5,true,primary);
 text(doc,String(report.progression_decision||'—').replace(/_/g,' '),x+128,dy+15,104,6.5,true,primary);
 text(doc,'ATTENDANCE',x+242,dy+5,76,4.5,true,primary);
 text(doc,report.attendance_days==null?'Not recorded':`${report.attendance_days}/${report.school_open_days??'—'} days`,x+242,dy+15,76,5.5,true,'#334155');
 text(doc,'CONDUCT / EFFORT',x+328,dy+5,94,4.5,true,primary);
 text(doc,[report.conduct,report.effort].filter(Boolean).join(' / ')||'Not recorded',x+328,dy+15,94,5.2,true,'#334155');
 text(doc,'NEXT TARGET',x+431,dy+5,100,4.5,true,primary);
 text(doc,report.next_term_target==null?'Not recorded':`${fmt(report.next_term_target)}%`,x+431,dy+15,100,6.2,true,'#334155');
 y+=42;

 // Signature / stamp strip
 const sy=Math.min(y+5,748);
 const sigW=150;
 line(doc,x,sy,x+sigW,sy,'#111111',.9);line(doc,x+195,sy,x+195+sigW,sy,'#111111',.9);line(doc,x+390,sy,x+w,sy,'#111111',.9);
 const cs=assetPath(report.class_teacher_signature_url),hs=assetPath(report.head_teacher_signature_url),st=assetPath(report.stamp_url);
 if(cs)try{doc.image(cs,x+18,sy-29,{fit:[110,27]});}catch{}
 if(hs)try{doc.image(hs,x+213,sy-29,{fit:[110,27]});}catch{}
 if(st)try{
   // Keep the stamp entirely inside the reserved stamp panel. A white backing
   // prevents transparent/irregular stamps from visually bleeding into the
   // signature labels while still leaving a little breathing room.
   doc.save().fillColor('#FFFFFF').rect(x+395,sy-39,143,37).fill().restore();
   doc.image(st,x+424,sy-35,{fit:[58,30],align:'center',valign:'center'});
 }catch{}
 text(doc,report.class_teacher||'CLASS TEACHER',x,sy+4,sigW,4.8,true,primary,'center');
 text(doc,report.head_teacher||'HEAD TEACHER',x+195,sy+4,sigW,4.8,true,primary,'center');
 text(doc,'SCHOOL STAMP',x+390,sy+4,149,4.8,true,primary,'center');
 text(doc,`Class Teacher  •  ${report.class_teacher_staff_no||'Staff No. —'}`,x,sy+15,190,4.2,false,'#64748B','center');
 text(doc,`Head Teacher  •  ${report.head_teacher_staff_no||'Staff No. —'}`,x+195,sy+15,190,4.2,false,'#64748B','center');
 text(doc,`Opening ${fmtDate(report.opening_date)} · Closing ${fmtDate(report.closing_date)}`,x+390,sy+15,149,4.2,false,'#64748B','center');
 line(doc,x,792,x+w,792,accent,.9);
 text(doc,`PRO-MARK • ${report.contact_email||'School contact email'} • Academic report • Generated from recorded school assessment data`,x,799,w,4.2,false,'#475569','center');
}
function renderFallbackBuffer(report,error){
  return new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:'A4',margin:0,autoFirstPage:true});
    const chunks=[];
    doc.on('data',c=>chunks.push(c));
    doc.on('end',()=>resolve(Buffer.concat(chunks)));
    doc.on('error',reject);
    const primary=hex(report?.primary_color,'#12355B');
    rounded(doc,28,28,539,786,8,'#fff','#111111');
    text(doc,'PRO-MARK REPORT CARD',55,70,485,18,true,primary,'center');
    text(doc,report?.school_name||'SCHOOL',55,105,485,12,true,'#0F172A','center');
    line(doc,55,130,540,130,'#111111',1);
    text(doc,report?.term_reports?'ANNUAL ACADEMIC REPORT':'ACADEMIC REPORT CARD',55,155,485,10,true,primary,'center');
    text(doc,`Learner: ${report?.learner_name||'—'}`,55,195,485,9,true,'#111827');
    text(doc,`Academic year: ${report?.year_label||'—'}`,55,215,485,8,false,'#334155');
    text(doc,`Class: ${report?.class_name||'—'}${report?.stream?' / '+report.stream:''}`,55,235,485,8,false,'#334155');
    text(doc,'The detailed report layout could not be rendered from the recorded data.',55,285,485,9,true,'#991B1B','center');
    text(doc,'The report data was generated successfully. Please reopen the report after checking the school/report configuration.',75,310,445,8,false,'#334155','center',{height:35,lineBreak:true});
    text(doc,`Render detail: ${String(error?.message||'unknown error').slice(0,220)}`,55,380,485,6,false,'#64748B','left',{height:60,lineBreak:true});
    text(doc,'PRO-MARK • Generated from recorded school assessment data',55,780,485,6,false,'#475569','center');
    doc.end();
  });
}
function renderBuffer(report){
  const safeReport=normalizeReport(report);
  return new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:'A4',margin:0,autoFirstPage:true});
    const chunks=[];
    let settled=false;
    const finish=(fn,value)=>{if(settled)return;settled=true;fn(value);};
    doc.on('data',c=>chunks.push(c));
    doc.on('end',()=>finish(resolve,Buffer.concat(chunks)));
    doc.on('error',async err=>{
      try{const fallback=await renderFallbackBuffer(safeReport,err);finish(resolve,fallback);}
      catch(e){finish(reject,e);}
    });
    try{
      drawReportPage(doc,safeReport);
      doc.end();
    }catch(err){
      try{doc.end();}catch{}
      renderFallbackBuffer(safeReport,err).then(v=>finish(resolve,v)).catch(reject);
    }
  });
}

async function reportPdf(report,res){
  const normalized=normalizeReport(report);
  const bytes=await renderBuffer(normalized);
  if(!bytes || !bytes.length)throw new Error('PDF renderer returned an empty document.');
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Disposition',`inline; filename="${safe(normalized.learner_name||'report').replace(/[^a-z0-9_-]/gi,'_')}.pdf"`);
  res.end(bytes);
}

async function buildReportPdfsBuffer(reports){
 const list=Array.isArray(reports)?reports.filter(Boolean).map(normalizeReport):[];
 if(!list.length) throw new Error('No report cards available for the selected class.');
 const out=await PDFLibDocument.create(); let pages=0;
 const batchSize=4;
 for(let i=0;i<list.length;i+=batchSize){
   const batch=list.slice(i,i+batchSize);
   const rendered=await Promise.all(batch.map(async report=>({report,bytes:await renderBuffer(report)})));
   for(const item of rendered){
     const src=await PDFLibDocument.load(item.bytes);
     const copied=await out.copyPages(src,src.getPageIndices());
     copied.forEach(page=>out.addPage(page)); pages+=copied.length;
   }
 }
 if(pages<list.length)throw new Error(`Whole-class report build incomplete: ${list.length} learner reports requested, ${pages} pages produced.`);
 return {bytes:Buffer.from(await out.save()),count:list.length,pages};
}
async function reportPdfs(reports,res,download=false){
 const built=await buildReportPdfsBuffer(reports);
 res.setHeader('Content-Type','application/pdf');
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Pro-Mark-Report-Count',String(built.count));
 res.setHeader('X-Pro-Mark-Page-Count',String(built.pages));
 res.setHeader('Content-Disposition',`${download?'attachment':'inline'}; filename="class-report-cards.pdf"`);
 res.end(built.bytes);
}
module.exports={reportPdf,reportPdfs,buildReportPdfsBuffer};
