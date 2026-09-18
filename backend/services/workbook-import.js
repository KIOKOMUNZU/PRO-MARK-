const fs = require('fs/promises');
const zlib = require('zlib');

// XLSX/XLSM files are ZIP containers. This tiny reader extracts only the XML
// parts needed for detection/import, avoiding a full ExcelJS workbook parse.
function zipEntries(buffer){
  const eocdSig=0x06054b50;
  let eocd=-1;
  for(let i=buffer.length-22;i>=0;i--){if(buffer.readUInt32LE(i)===eocdSig){eocd=i;break;}}
  if(eocd<0)throw new Error('The uploaded file is not a valid XLSX/XLSM workbook.');
  const count=buffer.readUInt16LE(eocd+10),dirOffset=buffer.readUInt32LE(eocd+16);
  const map=new Map();let p=dirOffset;
  for(let i=0;i<count;i++){
    if(buffer.readUInt32LE(p)!==0x02014b50)throw new Error('The workbook ZIP directory is invalid.');
    const method=buffer.readUInt16LE(p+10),compressed=buffer.readUInt32LE(p+20),nameLen=buffer.readUInt16LE(p+28),extraLen=buffer.readUInt16LE(p+30),commentLen=buffer.readUInt16LE(p+32),localOffset=buffer.readUInt32LE(p+42);
    const name=buffer.subarray(p+46,p+46+nameLen).toString('utf8');
    map.set(name,{method,compressed,localOffset});
    p+=46+nameLen+extraLen+commentLen;
  }
  return {buffer,map};
}
function zipRead(zip,name){
  const e=zip.map.get(name);if(!e)return null;
  const p=e.localOffset;
  if(zip.buffer.readUInt32LE(p)!==0x04034b50)throw new Error('The workbook contains an invalid ZIP entry.');
  const nameLen=zip.buffer.readUInt16LE(p+26),extraLen=zip.buffer.readUInt16LE(p+28);
  const data=zip.buffer.subarray(p+30+nameLen+extraLen,p+30+nameLen+extraLen+e.compressed);
  if(e.method===0)return data;
  if(e.method===8)return zlib.inflateRawSync(data);
  throw new Error(`Unsupported workbook compression method for ${name}.`);
}
const decodeXml=(value='')=>String(value).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));
const stripTags=s=>decodeXml(String(s||'').replace(/<t\b[^>]*>([\s\S]*?)<\/t>/g,'$1').replace(/<[^>]+>/g,''));
const attr=(attrs,name)=>{const m=String(attrs||'').match(new RegExp(`\\b${name}="([^"]*)"`));return m?decodeXml(m[1]):'';};
const colNumber=ref=>{const letters=String(ref||'').match(/^[A-Z]+/i)?.[0]?.toUpperCase()||'';let n=0;for(const ch of letters)n=n*26+(ch.charCodeAt(0)-64);return n;};
async function openWorkbook(filePath){return zipEntries(await fs.readFile(filePath));}
function workbookSheetMap(zip){
  const workbook=zipRead(zip,'xl/workbook.xml')?.toString('utf8')||'';const rels=zipRead(zip,'xl/_rels/workbook.xml.rels')?.toString('utf8')||'';const relMap=new Map();
  for(const m of rels.matchAll(/<Relationship\b([^>]*)\/>/g))relMap.set(attr(m[1],'Id'),attr(m[1],'Target'));
  const map=new Map();for(const tag of workbook.match(/<sheet\b[^>]*>/g)||[]){const name=attr(tag,'name'),rid=attr(tag,'r:id');let target=relMap.get(rid)||'';if(target.startsWith('/'))target=target.slice(1);if(!target.startsWith('xl/'))target=`xl/${target.replace(/^\.\//,'')}`;map.set(name,target);}return map;
}
function sharedStrings(zip){const file=zipRead(zip,'xl/sharedStrings.xml');if(!file)return [];const xml=file.toString('utf8'),out=[];for(const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g))out.push(stripTags(m[1]));return out;}
function readSheetRows(zip,sheetPath,strings){
  const file=zipRead(zip,sheetPath);if(!file)throw new Error(`Worksheet ${sheetPath} is missing from the workbook.`);const xml=file.toString('utf8');const rows=[];const sheetData=(xml.match(/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/)||[])[1]||'';
  for(const rm of sheetData.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)){const cells=[];for(const cm of rm[2].matchAll(/<c\b([^>]*?)(?:>([\s\S]*?)<\/c>|\/>)/g)){const attrs=cm[1],body=cm[2]||'',idx=colNumber(attr(attrs,'r'));if(!idx)continue;const type=attr(attrs,'t'),vm=body.match(/<v>([\s\S]*?)<\/v>/),inline=body.match(/<is>([\s\S]*?)<\/is>/);let value='';if(type==='s'&&vm)value=strings[Number(decodeXml(vm[1]))]??'';else if(type==='inlineStr'&&inline)value=stripTags(inline[1]);else if(type==='str'&&vm)value=decodeXml(vm[1]);else if(vm)value=decodeXml(vm[1]);else if(inline)value=stripTags(inline[1]);cells[idx]=value;}rows.push(cells);}return rows;
}
async function parseRelevantWorkbook(filePath){const zip=await openWorkbook(filePath),map=workbookSheetMap(zip),strings=sharedStrings(zip),teacherPath=map.get('TEACHERS'),markPath=map.get('MARK ENTRY');if(!teacherPath||!markPath)throw new Error('The workbook must contain both TEACHERS and MARK ENTRY sheets.');return {teachers:readSheetRows(zip,teacherPath,strings),marks:readSheetRows(zip,markPath,strings),sheets:[...map.keys()]};}
module.exports={parseRelevantWorkbook};
