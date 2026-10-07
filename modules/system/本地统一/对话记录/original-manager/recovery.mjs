import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../../public-paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
const HERE=path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/,'$1'));
const STATE=_publicPath("$system/本地统一/对话记录/original-routing-state.json");
const BINDINGS=_publicPath("$codex/context/bindings/codex");
const file=_publicDataPath("本地统一/对话记录/original-manager/new-binding-recovery.json");
const cmd=process.argv[2]||'capture';
if(cmd==='capture'){const state=JSON.parse(fs.readFileSync(STATE,'utf8'));const entries=Object.values(state.decisions).filter(d=>d.bindingCreated).map(d=>{const f=path.join(BINDINGS,d.threadId+'.json');return {threadId:d.threadId,file:f,prior:'absent',createdValue:JSON.parse(fs.readFileSync(f,'utf8')),decisionEvidence:STATE};});fs.writeFileSync(file,JSON.stringify({at:new Date().toISOString(),entries,boundary:'Only previously absent bindings created by this original-only manager. Existing bindings and user threads were not overwritten.'},null,2));console.log(JSON.stringify({captured:entries.length,file}));}
else if(cmd==='stop'){fs.writeFileSync(path.join(HERE,'STOP'),'Stop original-only watcher; no GUI action\n');console.log(JSON.stringify({requested:true,stopFile:path.join(HERE,'STOP')}));}
else if(cmd==='restore-bindings'){const data=JSON.parse(fs.readFileSync(file,'utf8')),results=[];for(const e of data.entries){if(!fs.existsSync(e.file)){results.push({id:e.threadId,status:'already-absent'});continue;}const current=JSON.parse(fs.readFileSync(e.file,'utf8'));if(JSON.stringify(current)!==JSON.stringify(e.createdValue)){results.push({id:e.threadId,status:'later-change-preserved'});continue;}fs.unlinkSync(e.file);results.push({id:e.threadId,status:'restored-absent'});}console.log(JSON.stringify({results}));}
else throw Error('Unknown recovery command');
