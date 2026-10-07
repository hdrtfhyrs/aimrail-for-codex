import path from 'node:path';

// All generated state belongs to the explicitly selected workspace.
// Import this module after setting AI_WORK_HOME when embedding the library.
export const WORKSPACE = path.resolve(process.env.AI_WORK_HOME || path.join(process.cwd(), 'workspace'));
export const PROJECTS_ROOT = path.join(WORKSPACE, 'projects');
export const MEMORY_ROOT = path.join(WORKSPACE, 'memory');
export const CACHE_ROOT = path.join(WORKSPACE, '.cache');
export const REGISTRY_FILE = path.join(WORKSPACE, 'resources.json');
export const OBJECTS_FILE = path.join(WORKSPACE, 'objects.json');
export const SOURCES_FILE = path.join(WORKSPACE, 'knowledge-sources.json');
