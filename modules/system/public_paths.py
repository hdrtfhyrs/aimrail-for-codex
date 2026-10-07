"""Shared public layout; no original user's paths or configuration are read."""
from pathlib import Path
import os
SYSTEM = Path(__file__).resolve().parent
REPOSITORY = SYSTEM.parents[1]
DATA = os.environ.get('AI_WORK_DATA_HOME', os.environ.get('AI_WORK_HOME', str(REPOSITORY/'workspace')))
ROOTS = {
    'system': os.environ.get('AI_WORK_SYSTEM_HOME', str(SYSTEM)),
    'codex': os.environ.get('AI_CODEX_HOME', str(REPOSITORY/'integrations')),
    'projects': os.environ.get('AI_PROJECTS_HOME', str(Path(DATA)/'projects')),
    'data': DATA,
    'user': os.environ.get('AI_USER_HOME', str(Path(DATA)/'user')),
    'runtime': os.environ.get('AI_RUNTIME_HOME', str(Path(DATA)/'runtime')),
    'plugins': os.environ.get('AI_PLUGINS_HOME', str(REPOSITORY/'plugins')),
    'models': os.environ.get('AI_MODEL_CLIENTS_HOME', str(REPOSITORY/'tools/model-clients')),
}
def public_path(value):
    value = str(value)
    if not value.startswith('$'): return value
    key, _, tail = value[1:].partition('/')
    if key not in ROOTS: raise ValueError('Unknown public root: '+key)
    state = Path(tail).name not in {'modules.json','schema.json','package.json','package-lock.json'} and Path(tail).suffix in {'.json','.sqlite','.db','.lock','.jsonl'} or any(part in {'bindings','failure-inbox','archive','sessions'} for part in Path(tail).parts)
    base = Path(DATA)/('integrations' if key=='codex' else 'system') if state and key in {'codex','system'} else Path(ROOTS[key])
    result = str((base/tail).resolve())
    return result + os.sep if value.endswith('/') else result
