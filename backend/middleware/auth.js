const jwt=require("jsonwebtoken");

function authenticate(req,res,next){
  const h=req.headers.authorization||"";
  const token=h.startsWith("Bearer ")?h.slice(7):null;
  if(!token)return res.status(401).json({error:"Authentication required"});
  try{req.user=jwt.verify(token,process.env.JWT_SECRET);next();}
  catch{return res.status(401).json({error:"Invalid or expired token"});}
}
function roles(...allowed){return (req,res,next)=>(req.user?.role==='PLATFORM_OWNER'||allowed.includes(req.user?.role))?next():res.status(403).json({error:"Insufficient permission"});}
async function schoolBoundary(req,res,next){
  const sid=req.params.schoolId||req.body?.school_id||req.query?.school_id;
  if(req.user?.role==='PLATFORM_OWNER')return next();
  if(!sid||!req.user?.school_id||sid!==req.user.school_id)return res.status(403).json({error:"School access denied"});
  try{
    const db=require('../db');
    const q=await db.query('SELECT status FROM schools WHERE id=$1',[sid]);
    if(!q.rows[0])return res.status(404).json({error:"School not found"});
    if(q.rows[0].status!=='ACTIVE')return res.status(403).json({error:`School is ${String(q.rows[0].status).toLowerCase()}`});
    next();
  }catch(e){console.error(e);res.status(500).json({error:"Unable to verify school access"});}
}
module.exports={authenticate,roles,schoolBoundary};
