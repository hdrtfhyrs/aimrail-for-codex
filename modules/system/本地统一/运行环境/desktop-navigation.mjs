import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../public-paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
const source=_publicPath("$system/成果/2026-10-02_对话管理与桌面整理/桌面/整理后目录与原路径映射.json");
export function desktopEntries(id){
 if(!fs.existsSync(source))return {entries:[],sources:[]};
 const mapping=JSON.parse(fs.readFileSync(source,'utf8').replace(/^\uFEFF/,''));
 const entries=mapping.filter(m=>m.destination&&typeof m.source==='string').map(m=>({id:id('desktop-entry',m.destination),kind:'desktop-entry',name:m.name,path:path.resolve(m.destination).replaceAll('\\','/'),originalPath:m.source.replaceAll('\\','/'),category:m.group,compatibility:m.kind==='directory-junction'?'hidden_directory_junction':m.kind==='root-launcher'?'hidden_launcher_forwarding':'mapping_preserved',originalPathExists:fs.existsSync(m.source),pathExists:fs.existsSync(m.destination),verification:'desktop_relocation_original_and_current_path_presence; no business program started',sources:[source,m.destination]}));
 const shortcuts=_publicPath("$data/external/用户文件/Desktop/00_常用入口");if(fs.existsSync(shortcuts))for(const name of fs.readdirSync(shortcuts).filter(n=>n.endsWith('.lnk'))){const file=path.join(shortcuts,name);entries.push({id:id('desktop-entry',file),kind:'desktop-entry',name:path.basename(name,'.lnk'),path:file.replaceAll('\\','/'),category:'00_常用入口',pathExists:true,verification:'shortcut file present; target evidence in original desktop verification',sources:[shortcuts,_publicPath("$system/成果/2026-10-02_对话管理与桌面整理/桌面/归位验证.json")]});}
 return {entries,sources:[source,shortcuts],scope:'Derived location navigation from actual desktop relocation receipt; original registry and resource facts remain authoritative.'};
}
