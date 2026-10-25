import importlib.machinery
import importlib.util
import os
import sys

def load_dynamic(module_name, module_path):
    module = None
    if not (loader := importlib.machinery.ExtensionFileLoader(module_name, module_path)):
        return None
    if not (spec := importlib.util.spec_from_loader(module_name, loader)):
        return None
    if not (module := importlib.util.module_from_spec(spec)):
        return None
    loader.exec_module(module)
    return module

if not (lib_path := os.getenv('RESOLVE_SCRIPT_LIB')):
    rel_path = {
        'darwin': '../../Libraries/Fusion/fusionscript.so',
        'win32': '../fusionscript.dll',
        'linux': '../libs/Fusion/fusionscript.so',
    }.get(sys.platform)
    if not rel_path:
        raise ImportError(f'ResolvePython: unsupported platform {sys.platform}')
    lib_path = os.path.normpath(os.path.join(sys.base_prefix, rel_path))

if not os.path.exists(lib_path):
    raise ImportError(f'ResolvePython: module "{lib_path}" does not exist')

# On Windows fusionscript looks for a Python to bind to in env vars, then in the registry, and would
# initialize a second interpreter if it picks a system install. Point it at the running interpreter.
# The lookup is cached on first import, so unset it after loading to avoid leaking to child processes.
if sys.platform == 'win32':
    os.environ['PYTHON3HOME'] = sys.base_prefix
try:
    script_module = load_dynamic('fusionscript', lib_path)
finally:
    if sys.platform == 'win32':
        del os.environ['PYTHON3HOME']

if not script_module:
    raise ImportError(f'ResolvePython: failed to import module "{lib_path}"')

sys.modules[__name__] = script_module
