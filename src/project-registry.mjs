import fs from 'node:fs';
import path from 'node:path';
import {WORKSPACE,PROJECTS_ROOT} from './paths.mjs';
import {readRegistry} from './registry-store.mjs';

export function projectDirectory({roots}={}) {
  const registry=path.join(WORKSPACE,'projects.json');
  const config=readRegistry(registry,{schemaVersion:1,roots:[PROJECTS_ROOT],projects:[]});
  const selectedRoots=(roots||config.roots||[PROJECTS_ROOT]).map(root=>path.resolve(WORKSPACE,root));
  const found=new Map(), errors=[];
  for(const root of selectedRoots) {
    if(!fs.existsSync(root)) continue;
    for(const entry of fs.readdirSync(root,{withFileTypes:true})) {
      if(entry.isDirectory() && fs.existsSync(path.join(root,entry.name,'核心.md'))) found.set(path.join(root,entry.name),{});
    }
  }
  for(const record of config.projects||[]) {
    if(record.projectPath) found.set(path.resolve(WORKSPACE,record.projectPath),record);
  }
  const projects=[];
  for(const [projectPath,record] of found) {
    const core=path.join(projectPath,'核心.md');
    try {
      const text=fs.readFileSync(core,'utf8').replace(/^\uFEFF/,'');
      const goalSection=text.match(/^#{1,6}\s+最终要做出什么[^\S\r\n]*\r?\n([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/m)?.[1]||text;
      const goal=goalSection.split(/\r?\n\s*\r?\n/).map(line=>line.trim()).find(line=>line&&!/^(#|>|<!--)/.test(line))||'';
      projects.push({...record,name:record.name||path.basename(projectPath),projectPath,aliases:record.aliases||[],core,goal,groups:[]});
    } catch(error) { errors.push({project:projectPath,reason:error.message}); }
  }
  return {projects:projects.sort((a,b)=>a.name.localeCompare(b.name)),errors,roots:selectedRoots,registry,createRoot:PROJECTS_ROOT};
}
