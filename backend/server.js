require("dotenv").config();
const express=require("express"),cors=require("cors"),path=require("path"),fs=require("fs");
const app=express(),PORT=process.env.PORT||3000,HOST=process.env.HOST||'0.0.0.0';
const db=require("./db"),{ensureAssessmentWorkflowSchema}=require("./schema-compat");
app.use(cors());app.use(express.json({limit:"4mb"}));app.use(express.urlencoded({extended:true}));app.use((req,res,next)=>{if(req.path.startsWith("/api/")){res.setHeader("Cache-Control","no-store");res.setHeader("Content-Type","application/json; charset=utf-8");}next();});
app.use(express.static(path.join(__dirname,"..","public")));fs.mkdirSync(path.join(__dirname,"..","uploads"),{recursive:true});app.use('/uploads',express.static(path.join(__dirname,'..','uploads')));
app.get("/api/health",async(req,res)=>{try{await db.query("SELECT 1");res.json({ok:true,app:"PRO-MARK",version:"3.10.0",database:"connected",timestamp:new Date().toISOString()});}catch(e){res.status(503).json({ok:false,app:"PRO-MARK",version:"3.10.0",database:"unavailable",error:e.message,timestamp:new Date().toISOString()});}});
app.use("/api/auth",require("./routes/auth"));
app.use("/api/platform",require("./routes/platform"));
app.use("/api/school",require("./routes/school"));
app.use("/api/settings",require("./routes/settings"));
app.use("/api/people",require("./routes/people"));
app.use("/api/assessments",require("./routes/assessments"));
app.use("/api/grading",require("./routes/grading"));
app.use("/api/merit",require("./routes/merit"));
app.use("/api/reports",require("./routes/reports"));
app.use("/api/documents",require("./routes/documents"));
app.use("/api/communications",require("./routes/communications"));
app.use("/api/billing",require("./routes/billing"));
app.use("/api/operations",require("./routes/operations"));
app.get("/{*splat}",(req,res)=>res.sendFile(path.join(__dirname,"..","public","index.html")));
app.use((err,req,res,next)=>{console.error("Unhandled request error:",err);if(res.headersSent)return next(err);if(req.path.startsWith("/api/"))return res.status(err.status||500).json({error:err.message||"Internal server error."});return res.status(err.status||500).send("Internal server error.");});
(async()=>{
  try{
    await ensureAssessmentWorkflowSchema();
    app.listen(PORT,HOST,()=>console.log(`PRO-MARK running at http://localhost:${PORT} (LAN: http://<YOUR-PC-IP>:${PORT})`));
  }catch(e){
    console.error('PRO-MARK database compatibility check failed:',e.message);
    process.exit(1);
  }
})();
