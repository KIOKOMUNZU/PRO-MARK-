const PDFDocument=require('pdfkit');
const fs=require('fs'),path=require('path');
const {source:assetSource}=require('./assets');
const {PDFDocument:PDFLibDocument}=require('pdf-lib');
const safe=s=>String(s??'').replace(/[<>]/g,'');
function assetPath(url){return assetSource(url);}
function hex(c,fallback){const v=String(c||'').toUpperCase();if(v==='#17365D')return '#0B4F8A';if(v==='#D9A441')return '#16A36A';return /^#[0-9A-F]{6}$/i.test(v)?v:fallback;}
function rounded(doc,x,y,w,h,r,fill,stroke){if(fill)doc.fillColor(fill).roundedRect(x,y,w,h,r).fill();if(stroke)doc.strokeColor(stroke).lineWidth(.95).roundedRect(x,y,w,h,r).stroke();}
function text(doc,t,x,y,w,size,bold,color,align='left',opts={}){doc.fillColor(color||'#222').font(bold?'Helvetica-Bold':'Helvetica').fontSize(size||7).text(safe(t),x,y,{width:w,align,lineGap:0,ellipsis:!!opts.ellipsis,height:opts.height,lineBreak:opts.lineBreak!==false});}
function line(doc,x1,y1,x2,y2,c='#111111',lw=.9){doc.save().strokeColor(c).lineWidth(lw).moveTo(x1,y1).lineTo(x2,y2).stroke().restore();}
function stars(doc,x,y,w,h,color){doc.save().strokeColor(color).lineWidth(1.25).roundedRect(x,y,w,h,7).stroke();doc.font('Helvetica-Bold').fontSize(7).fillColor(color);for(let xx=x+7;xx<x+w-5;xx+=15){doc.text('★',xx,y-1,{width:9});doc.text('★',xx,y+h-8,{width:9});}for(let yy=y+12;yy<y+h-8;yy+=15){doc.text('★',x-2,yy,{width:9});doc.text('★',x+w-5,yy,{width:9});}doc.restore();}
function drawLogo(doc,url,cx,y,size){const p=assetPath(url);if(!p)return false;try{doc.image(p,cx-size/2,y,{fit:[size,size],align:'center',valign:'center'});return true;}catch{return false;}}
function drawWatermark(doc,url,cx,cy,size,opacity=.075){const p=assetPath(url);if(!p)return false;try{doc.save().opacity(opacity);doc.image(p,cx-size/2,cy-size/2,{fit:[size,size],align:'center',valign:'center'});doc.restore();return true;}catch{doc.restore?.();return false;}}
function drawPhoto(doc,url,x,y,w,h,border){const p=assetPath(url);rounded(doc,x,y,w,h,4,'#F1F4F7',border);if(p){try{doc.image(p,x+3,y+3,{fit:[w-6,h-6],align:'center',valign:'center'});}catch{}}else{text(doc,'PASSPORT',x,y+h/2-4,w,6,true,'#94a3b8','center');}}
function fmt(v){const n=Number(v);return Number.isFinite(n)?(Math.abs(n-Math.round(n))<0.00001?String(Math.round(n)):n.toFixed(2).replace(/0+$/,'').replace(/\.$/,'')):'—';}
function gradeColor(g){const s=String(g||'').toUpperCase();if(['EE','A','A+'].includes(s))return '#15803d';if(['ME','B','B+','B-'].includes(s))return '#2563eb';if(['AE','C','C+','C-'].includes(s))return '#d97706';if(['BE','D','D-','E'].includes(s))return '#dc2626';return '#26384A';}
function designationColor(d){const s=String(d||'').toUpperCase();if(s==='DISTINCTION')return '#15803d';if(['MERIT','CREDIT'].includes(s))return '#2563eb';if(s==='PASS')return '#d97706';if(['AT_RISK','INCOMPLETE'].includes(s))return '#dc2626';return '#6b7280';}
function drawMiniTrend(doc,values,x,y,w,h,primary,label){text(doc,label,x,y-11,w,6.5,true,primary);rounded(doc,x,y,w,h,5,'#F1F4F7','#111111');const vals=values.filter(v=>v!=null).map(Number);if(!vals.length){text(doc,'No assessed marks yet',x+5,y+h/2-3,w-10,6,false,'#94a3b8','center');return;}const pts=vals.map((v,i)=>{const px=x+12+(w-24)*(i/Math.max(1,vals.length-1));const py=y+h-11-(Math.max(0,Math.min(100,v))/100)*(h-22);return [px,py];});for(let i=1;i<pts.length;i++)line(doc,pts[i-1][0],pts[i-1][1],pts[i][0],pts[i][1],primary,1.4);pts.forEach((p,i)=>{doc.save().fillColor(primary).circle(p[0],p[1],2.2).fill();doc.restore();text(doc,String(Math.round(vals[i])),p[0]-8,p[1]-10,16,4.4,true,primary,'center');});}
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
 // Formal double school-document frame: black outer rule + bold red/primary inner rule.
 doc.save().strokeColor('#111111').lineWidth(2.2).rect(10,10,pageW-20,pageH-20).stroke().restore();
 doc.save().strokeColor(primary).lineWidth(1.6).rect(17,17,pageW-34,pageH-34).stroke().restore();
 stars(doc,18,18,pageW-36,pageH-36,accent);
 // Security-style PRO-MARK watermark: subtle, centered, and behind report content.
 if(report.logo_url)drawWatermark(doc,report.logo_url,pageW/2,pageH/2,300,.045);
 // Header hierarchy: address/contact above the centered school logo, followed by the school title.
 const contact=[report.address,report.contact_phone,report.contact_email].filter(Boolean).join('  |  ');
 if(contact)text(doc,contact,x,17,w,5.4,false,'#374151','center');
 if(report.logo_url)drawLogo(doc,report.logo_url,pageW/2,34,64);
 text(doc,report.school_name||'SCHOOL',x,102,w,16,true,primary,'center');
 text(doc,report.motto||'',x,121,w,6.5,false,'#334155','center');
 line(doc,x,133,x+w,133,accent,1.1);
 text(doc,report.term_reports?'ANNUAL ACADEMIC REPORT':'ACADEMIC REPORT CARD',x,140,w,10.5,true,primary,'center');
 text(doc,`ACADEMIC YEAR ${safe(report.year_label)}${report.term_reports?'':'  •  '+safe(report.term_name||'TERM')}`,x,154,w,5.8,true,'#334155','center');

 // Learner identity block
 const iy=167,ih=58;
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
 text(doc,`${report.opening_date||'—'} – ${report.closing_date||'—'}`,x+125,iy+44,220,5.3,false,'#334155');

 let y=228;
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
   text(doc,'SUBJECT PERFORMANCE AND TEACHER FEEDBACK',x,y,w,7.2,true,primary);
   line(doc,x,y+11,x+w,y+11,accent,1.2);
   y+=16;
   const standard=Number(report.term_no)===3
     ? [{type:'OPENER',label:'OPENER'} ,{type:'END_TERM',label:'END TERM'}]
     : [{type:'OPENER',label:'OPENER'},{type:'MID_TERM',label:'MID TERM'},{type:'END_TERM',label:'END TERM'}];
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
     text(doc,col.label,xx+2,y+5,cw-4,col.key==='comment'||col.key==='teacher'?4.7:4.5,true,'#fff',col.align==='left'?'left':'center',{height:17,lineBreak:false,ellipsis:true});
     if(i<columns.length-1)line(doc,c[i+1],y,c[i+1],y+25,'#FFFFFF',1);
   });
   y+=25;
   const rows=report.subjects||[];
   // Keep the complete table inside the A4 body while preserving a usable teacher
   // and automatic-comment column. The minimum row height prevents text collision.
   const rh=rows.length?Math.max(25,Math.min(36,Math.floor(215/rows.length))):30;
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
         text(doc,value,xx+3,y+4,cw-6,4.6,true,'#334155','center',{height:rh-7,lineBreak:true,ellipsis:true});
       }else if(col.key==='comment'){
         text(doc,value,xx+5,y+5,cw-10,4.8,false,'#334155','left',{height:rh-8,lineBreak:true,ellipsis:true});
       }else if(col.key==='subject'){
         text(doc,value,xx+4,y+6,cw-8,5.8,true,'#111827','left',{height:rh-9,lineBreak:false,ellipsis:true});
       }else{
         text(doc,value,xx+2,y+6,cw-4,col.key==='grade'?6.0:5.5,true,col.key==='grade'?gradeColor(s.grade):'#1F2937','center',{height:rh-9,lineBreak:false,ellipsis:true});
       }
     });
     y+=rh;
   });
 }
 // Overall summary
 y+=7;
 const cardW=(w-18)/4, cards=[
   ['OVERALL AVERAGE',report.overall_average==null?'—':fmt(report.overall_average)],
   ['OVERALL GRADE',report.overall_grade||'—'],
   ['CLASS RANK',report.overall_subject_rank==null?'—':String(report.overall_subject_rank)],
   ['DESIGNATION',String(report.designation||'—').replace(/_/g,' ')]
 ];
 cards.forEach((a,i)=>{const xx=x+i*(cardW+6),highlight=i===1?gradeColor(a[1]):i===3?designationColor(a[1]):null;rounded(doc,xx,y,cardW,34,4,highlight||'#F8FAFC',highlight||'#111111');text(doc,a[0],xx+4,y+5,cardW-8,4.0,true,highlight?'#fff':primary,'center');text(doc,a[1],xx+4,y+17,cardW-8,i===4?5.7:8,true,highlight?'#fff':'#0F172A','center');});
 y+=42;

 // Pivotal visual performance graphs retained on the report card.
 const graphW=(w-8)/2, graphH=78;
 if(y+graphH+10<760){
   const trendValues=[];
   if(report.term_reports){
     const firstSubject=(report.subjects||[])[0];
     if(firstSubject) trendValues=[1,2,3].map(tn=>firstSubject.terms?.[tn]).filter(v=>v!=null);
   } else {
     (report.subjects||[]).forEach(s=>(s.assessments||[]).forEach(a=>{if(a.percent!=null)trendValues.push(a.percent);}));
   }
   drawMiniTrend(doc,trendValues,x,y+10,graphW,graphH,primary,'ASSESSMENT / TERM TREND');
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
 if(st)try{doc.image(st,x+428,sy-34,{fit:[55,55]});}catch{}
 text(doc,report.class_teacher||'CLASS TEACHER',x,sy+4,sigW,4.8,true,primary,'center');
 text(doc,report.head_teacher||'HEAD TEACHER',x+195,sy+4,sigW,4.8,true,primary,'center');
 text(doc,'SCHOOL STAMP',x+390,sy+4,149,4.8,true,primary,'center');
 text(doc,`Class Teacher  •  ${report.class_teacher_staff_no||'Staff No. —'}`,x,sy+15,190,4.2,false,'#64748B','center');
 text(doc,`Head Teacher  •  ${report.head_teacher_staff_no||'Staff No. —'}`,x+195,sy+15,190,4.2,false,'#64748B','center');
 text(doc,`Opening: ${report.opening_date||'—'}   Closing: ${report.closing_date||'—'}`,x+390,sy+15,149,4.2,false,'#64748B','center');
 line(doc,x,792,x+w,792,accent,.9);
 text(doc,`PRO-MARK • ${report.contact_email||'School contact email'} • Academic report • Generated from recorded school assessment data`,x,799,w,4.2,false,'#475569','center');
}
function renderBuffer(report){return new Promise((resolve,reject)=>{const doc=new PDFDocument({size:'A4',margin:0,autoFirstPage:true});const chunks=[];doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);drawReportPage(doc,report);doc.end();});}
async function reportPdf(report,res){
  // Render completely before sending headers. If PDFKit encounters a bad asset or
  // layout value, the route can return JSON instead of sending a corrupt PDF stream.
  const bytes=await renderBuffer(report);
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`inline; filename="${safe(report.learner_name||'report').replace(/[^a-z0-9_-]/gi,'_')}.pdf"`);
  res.end(bytes);
}
async function reportPdfs(reports,res){const out=await PDFLibDocument.create();for(const r of reports){const bytes=await renderBuffer(r),src=await PDFLibDocument.load(bytes);(await out.copyPages(src,src.getPageIndices())).forEach(p=>out.addPage(p));}res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition','inline; filename="class-report-cards.pdf"');res.end(Buffer.from(await out.save()));}
module.exports={reportPdf,reportPdfs};
