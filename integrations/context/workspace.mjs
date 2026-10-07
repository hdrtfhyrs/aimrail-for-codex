// Stable user-level alias. The project module owns implementation and indexes.
import {workspaceCli} from '../../modules/system/本地统一/workspace.mjs';
try{process.exitCode=await workspaceCli();}catch(e){console.error(e.message);process.exitCode=1;}
