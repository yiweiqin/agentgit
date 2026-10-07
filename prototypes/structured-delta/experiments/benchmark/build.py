"""48 authored micro-repositories. Extend with another add() call; no case cap.

Gold and witness code live only in benchmark artifacts. Detectors do not import
this module. Cases are a development benchmark, NOT independently held-out data.
"""

import argparse
import difflib
import json
import textwrap
from collections import Counter
from pathlib import Path

CASES = []


def clean(s):
    return textwrap.dedent(s).lstrip("\n").rstrip() + "\n"


def add(
    title,
    label,
    family,
    base,
    a,
    b,
    entity,
    why,
    check_a,
    check_b,
    check_base="",
    witness=None,
    online=False,
):
    base = {p: clean(s) for p, s in base.items()}

    def version(changes):
        out = dict(base)
        for p, s in changes.items():
            if s is None:
                out.pop(p, None)
            else:
                out[p] = clean(s)
        return out

    aa, bb = version(a), version(b)
    CASES.append(
        dict(
            id=f"case{len(CASES) + 1:03}",
            title=title,
            label=label,
            family=family,
            base=base,
            a=aa,
            b=bb,
            entities=[] if entity is None else [entity],
            explanation=why,
            checks={
                "base": clean(check_base),
                "a": clean(check_a),
                "b": clean(check_b),
            },
            witness=version(witness)
            if witness is not None
            else (aa if label == "redundant" else None),
            online=online,
        )
    )


def cases():
    if CASES:
        return CASES
    # Independent: varied scopes, including same-file and shared dictionary roots.
    add(
        "Unrelated arithmetic modules",
        "independent",
        "unrelated_files",
        {"left.py": "def inc(x): return x+1", "right.py": "def twice(x): return x*2"},
        {"left.py": "def inc(x): return x+2"},
        {"right.py": "def twice(x): return x*3"},
        None,
        "Different modules have no calls or shared state.",
        "from left import inc\nassert inc(1)==3",
        "from right import twice\nassert twice(2)==6",
        witness={
            "left.py": "def inc(x): return x+2",
            "right.py": "def twice(x): return x*3",
        },
        online=True,
    )
    add(
        "Separate functions in one file",
        "independent",
        "disjoint_symbols",
        {"ops.py": "def left(): return 1\n\ndef right(): return 2"},
        {"ops.py": "def left(): return 10\n\ndef right(): return 2"},
        {"ops.py": "def left(): return 1\n\ndef right(): return 20"},
        None,
        "No state or call edge between the functions.",
        "from ops import left\nassert left()==10",
        "from ops import right\nassert right()==20",
        witness={"ops.py": "def left(): return 10\n\ndef right(): return 20"},
    )
    add(
        "Separate classes",
        "independent",
        "disjoint_symbols",
        {
            "model.py": 'class Cat:\n    def sound(self): return "mew"\n\nclass Dog:\n    def sound(self): return "woof"'
        },
        {
            "model.py": 'class Cat:\n    def sound(self): return "purr"\n\nclass Dog:\n    def sound(self): return "woof"'
        },
        {
            "model.py": 'class Cat:\n    def sound(self): return "mew"\n\nclass Dog:\n    def sound(self): return "bark"'
        },
        None,
        "Neither class refers to the other.",
        'from model import Cat\nassert Cat().sound()=="purr"',
        'from model import Dog\nassert Dog().sound()=="bark"',
        witness={
            "model.py": 'class Cat:\n    def sound(self): return "purr"\n\nclass Dog:\n    def sound(self): return "bark"'
        },
    )
    add(
        "Separate state keys",
        "independent",
        "field_sensitive",
        {
            "state.py": 'VALUES={"a":0,"b":0}\ndef set_a(): VALUES["a"]=1\ndef set_b(): VALUES["b"]=1'
        },
        {
            "state.py": 'VALUES={"a":0,"b":0}\ndef set_a(): VALUES["a"]=2\ndef set_b(): VALUES["b"]=1'
        },
        {
            "state.py": 'VALUES={"a":0,"b":0}\ndef set_a(): VALUES["a"]=1\ndef set_b(): VALUES["b"]=3'
        },
        None,
        "Distinct dictionary keys can be assigned independently.",
        'import state\nstate.set_a()\nassert state.VALUES["a"]==2',
        'import state\nstate.set_b()\nassert state.VALUES["b"]==3',
        witness={
            "state.py": 'VALUES={"a":0,"b":0}\ndef set_a(): VALUES["a"]=2\ndef set_b(): VALUES["b"]=3'
        },
    )
    add(
        "Library import unrelated to formatter",
        "independent",
        "unrelated_files",
        {
            "calc.py": "def root(x): return x**0.5",
            "fmt.py": "def format_name(x): return x",
        },
        {"calc.py": "import math\ndef root(x): return math.sqrt(x)"},
        {"fmt.py": "def format_name(x): return x.upper()"},
        None,
        "Import has no dependency on formatter.",
        "from calc import root\nassert root(9)==3",
        'from fmt import format_name\nassert format_name("a")=="A"',
        witness={
            "calc.py": "import math\ndef root(x): return math.sqrt(x)",
            "fmt.py": "def format_name(x): return x.upper()",
        },
    )
    add(
        "Annotation and unrelated new endpoint",
        "independent",
        "unrelated_files",
        {"a.py": "def f(x): return x", "b.py": "def g(): return 0"},
        {"a.py": "def f(x: int) -> int: return x"},
        {"b.py": "def g(): return 0\ndef h(): return 4"},
        None,
        "Type annotation has no consumer in other patch.",
        "from a import f\nassert f(3)==3",
        "from b import h\nassert h()==4",
        witness={
            "a.py": "def f(x: int) -> int: return x",
            "b.py": "def g(): return 0\ndef h(): return 4",
        },
    )
    add(
        "Independent configuration keys",
        "independent",
        "disjoint_config",
        {"config.py": 'TIMEOUT=10\nCOLOR="blue"'},
        {"config.py": 'TIMEOUT=20\nCOLOR="blue"'},
        {"config.py": 'TIMEOUT=10\nCOLOR="red"'},
        None,
        "No consumer couples timeout and color.",
        "from config import TIMEOUT\nassert TIMEOUT==20",
        'from config import COLOR\nassert COLOR=="red"',
        witness={"config.py": 'TIMEOUT=20\nCOLOR="red"'},
    )
    add(
        "Comment and behavior elsewhere",
        "independent",
        "nonsemantic",
        {"a.py": "# identity\ndef f(x): return x", "b.py": "def g(): return 1"},
        {"a.py": "# Return input unchanged.\ndef f(x): return x"},
        {"b.py": "def g(): return 2"},
        None,
        "Comment has no runtime effect.",
        "from a import f\nassert f(2)==2",
        "from b import g\nassert g()==2",
        witness={
            "a.py": "# Return input unchanged.\ndef f(x): return x",
            "b.py": "def g(): return 2",
        },
    )
    add(
        "Same spelling in different modules",
        "independent",
        "qualified_names",
        {"a.py": "VERSION=1", "b.py": "VERSION=1"},
        {"a.py": "VERSION=1\ndef parse(x): return int(x)"},
        {"b.py": 'VERSION=1\ndef parse(x): return x.split(",")'},
        None,
        "Qualified symbols differ despite identical names.",
        'from a import parse\nassert parse("2")==2',
        'from b import parse\nassert parse("a,b")==["a","b"]',
        witness={
            "a.py": "VERSION=1\ndef parse(x): return int(x)",
            "b.py": 'VERSION=1\ndef parse(x): return x.split(",")',
        },
    )
    add(
        "Delete unused file and edit another",
        "independent",
        "file_lifecycle",
        {"old.py": "UNUSED=1", "live.py": "def value(): return 1"},
        {"old.py": None},
        {"live.py": "def value(): return 2"},
        None,
        "Deleted file has no live imports.",
        'from pathlib import Path\nassert not Path("old.py").exists()',
        "from live import value\nassert value()==2",
        witness={"old.py": None, "live.py": "def value(): return 2"},
    )
    # Compatible: shared scope/edge, both requirements can coexist.
    parse = {"parser.py": "import logging\ndef parse(x):\n    return int(x)"}
    validate = 'import logging\ndef parse(x):\n    if x is None: raise ValueError("empty")\n    return int(x)'
    log = 'import logging\ndef parse(x):\n    logging.info("parse")\n    return int(x)'
    ca = 'from parser import parse\ntry: parse(None)\nexcept ValueError: pass\nelse: raise AssertionError("validation missing")'
    cb = 'from unittest.mock import patch\nfrom parser import parse\nwith patch("parser.logging.info") as log:\n    assert parse("2")==2\n    log.assert_called_once_with("parse")'
    add(
        "Validation plus logging",
        "compatible",
        "same_function_additive",
        parse,
        {"parser.py": validate},
        {"parser.py": log},
        "parser.py::parse",
        "Input validation and successful-call logging can both be preserved.",
        ca,
        cb,
        witness={
            "parser.py": 'import logging\ndef parse(x):\n    if x is None: raise ValueError("empty")\n    logging.info("parse")\n    return int(x)'
        },
        online=True,
    )
    add(
        "Overlapping one-line replacements",
        "compatible",
        "overlapping_lines",
        {"parser.py": "import logging\ndef parse(x): return int(x)"},
        {"parser.py": validate},
        {"parser.py": log},
        "parser.py::parse",
        "Both replace the same physical line but request independent added effects.",
        ca,
        cb,
        witness={
            "parser.py": 'import logging\ndef parse(x):\n    if x is None: raise ValueError("empty")\n    logging.info("parse")\n    return int(x)'
        },
    )
    add(
        "Docstring and implementation",
        "compatible",
        "same_function_additive",
        {"ops.py": "def double(x):\n    return x*2"},
        {"ops.py": 'def double(x):\n    """Multiply by two."""\n    return x*2'},
        {"ops.py": "def double(x):\n    return x+x"},
        "ops.py::double",
        "Documentation and equivalent arithmetic coexist.",
        'from ops import double\nassert double.__doc__=="Multiply by two."',
        "from ops import double\nassert double(4)==8",
        witness={
            "ops.py": 'def double(x):\n    """Multiply by two."""\n    return x+x'
        },
    )
    add(
        "Optional argument and logging",
        "compatible",
        "signature_compatible",
        {"ops.py": "import logging\ndef scale(x):\n    return x*2"},
        {"ops.py": "import logging\ndef scale(x, factor=2):\n    return x*factor"},
        {
            "ops.py": 'import logging\ndef scale(x):\n    logging.info("scale")\n    return x*2'
        },
        "ops.py::scale",
        "Default preserves old calls while logging adds an effect.",
        "from ops import scale\nassert scale(2,3)==6",
        'from unittest.mock import patch\nfrom ops import scale\nwith patch("ops.logging.info") as p:\n    assert scale(2)==4\n    p.assert_called_once()',
        witness={
            "ops.py": 'import logging\ndef scale(x, factor=2):\n    logging.info("scale")\n    return x*factor'
        },
    )
    add(
        "Producer optional parameter and old-shape caller",
        "compatible",
        "cross_file_compatible",
        {
            "api.py": "def get(x): return x",
            "client.py": "from api import get\ndef run(): return get(1)",
        },
        {"api.py": "def get(x, extra=0): return x+extra"},
        {"client.py": "from api import get\ndef run(): return get(2)"},
        "api.py::get",
        "New parameter is optional; existing arity remains valid.",
        "from api import get\nassert get(2,3)==5",
        "from client import run\nassert run()==2",
        witness={
            "api.py": "def get(x, extra=0): return x+extra",
            "client.py": "from api import get\ndef run(): return get(2)",
        },
        online=True,
    )
    add(
        "Add result key with tolerant consumer",
        "compatible",
        "contract_compatible",
        {
            "api.py": 'def get(): return {"id":1}',
            "client.py": 'from api import get\ndef run(): return get()["id"]',
        },
        {"api.py": 'def get(): return {"id":1,"name":"A"}'},
        {"client.py": 'from api import get\ndef run(): return get()["id"]+1'},
        "api.py::get",
        "Consumer accesses retained key; added key is backward compatible.",
        'from api import get\nassert get()["name"]=="A"',
        "from client import run\nassert run()==2",
        witness={
            "api.py": 'def get(): return {"id":1,"name":"A"}',
            "client.py": 'from api import get\ndef run(): return get()["id"]+1',
        },
        online=True,
    )
    add(
        "Config change with tolerant consumer",
        "compatible",
        "config_compatible",
        {
            "config.py": "LIMIT=10",
            "client.py": "from config import LIMIT\ndef valid(x): return x<LIMIT",
        },
        {"config.py": "LIMIT=20"},
        {"client.py": "from config import LIMIT\ndef valid(x): return 0<=x<LIMIT"},
        "config.py::LIMIT",
        "Nonnegative validation does not require the old limit.",
        "from config import LIMIT\nassert LIMIT==20",
        "from client import valid\nassert not valid(-1) and valid(5)",
        witness={
            "config.py": "LIMIT=20",
            "client.py": "from config import LIMIT\ndef valid(x): return 0<=x<LIMIT",
        },
    )
    add(
        "Commutative shared-state increments",
        "compatible",
        "commutative_state",
        {
            "state.py": "COUNT=0\ndef a():\n    global COUNT\n    COUNT+=1\ndef b():\n    global COUNT\n    COUNT+=1"
        },
        {
            "state.py": "COUNT=0\ndef a():\n    global COUNT\n    COUNT+=2\ndef b():\n    global COUNT\n    COUNT+=1"
        },
        {
            "state.py": "COUNT=0\ndef a():\n    global COUNT\n    COUNT+=1\ndef b():\n    global COUNT\n    COUNT+=3"
        },
        "state.py::COUNT",
        "Each counter operation has an independent increment contract; both can coexist.",
        "import state\nstate.COUNT=0\nstate.a()\nassert state.COUNT==2",
        "import state\nstate.COUNT=0\nstate.b()\nassert state.COUNT==3",
        witness={
            "state.py": "COUNT=0\ndef a():\n    global COUNT\n    COUNT+=2\ndef b():\n    global COUNT\n    COUNT+=3"
        },
        online=True,
    )
    add(
        "Two methods added to a class",
        "compatible",
        "class_extension",
        {"model.py": "class Item:\n    def id(self): return 1"},
        {
            "model.py": 'class Item:\n    def id(self): return 1\n    def name(self): return "A"'
        },
        {
            "model.py": "class Item:\n    def id(self): return 1\n    def size(self): return 2"
        },
        "model.py::Item",
        "Distinct methods extend one class without changing old behavior.",
        'from model import Item\nassert Item().name()=="A"',
        "from model import Item\nassert Item().size()==2",
        witness={
            "model.py": 'class Item:\n    def id(self): return 1\n    def name(self): return "A"\n    def size(self): return 2'
        },
    )
    add(
        "Two complementary validations",
        "compatible",
        "same_function_additive",
        {"ops.py": "def square(x):\n    return x*x"},
        {
            "ops.py": 'def square(x):\n    if x<0: raise ValueError("negative")\n    return x*x'
        },
        {
            "ops.py": 'def square(x):\n    if x>10: raise ValueError("large")\n    return x*x'
        },
        "ops.py::square",
        "Disjoint rejected domains preserve the common valid domain.",
        "from ops import square\ntry: square(-1)\nexcept ValueError: pass\nelse: raise AssertionError()",
        "from ops import square\ntry: square(11)\nexcept ValueError: pass\nelse: raise AssertionError()",
        witness={
            "ops.py": 'def square(x):\n    if x<0: raise ValueError("negative")\n    if x>10: raise ValueError("large")\n    return x*x'
        },
    )
    add(
        "Equivalent producer optimization and new consumer",
        "compatible",
        "dependency_compatible",
        {
            "api.py": "def double(x: int): return x*2",
            "client.py": "from api import double\ndef run(): return double(1)",
        },
        {"api.py": "def double(x: int): return x+x"},
        {"client.py": "from api import double\ndef run(): return double(3)"},
        "api.py::double",
        "Integer-domain optimization preserves the called behavior.",
        "from api import double\nassert double(4)==8",
        "from client import run\nassert run()==6",
        witness={
            "api.py": "def double(x: int): return x+x",
            "client.py": "from api import double\ndef run(): return double(3)",
        },
    )
    add(
        "Type annotation plus runtime guard",
        "compatible",
        "annotation_compatible",
        {"ops.py": "def length(x):\n    return len(x)"},
        {"ops.py": "def length(x: str) -> int:\n    return len(x)"},
        {
            "ops.py": 'def length(x):\n    if x is None: raise ValueError("empty")\n    return len(x)'
        },
        "ops.py::length",
        "Annotation and guard impose no contradictory runtime result.",
        'from ops import length\nassert length.__annotations__["x"] is str',
        "from ops import length\ntry: length(None)\nexcept ValueError: pass\nelse: raise AssertionError()",
        witness={
            "ops.py": 'def length(x: str) -> int:\n    if x is None: raise ValueError("empty")\n    return len(x)'
        },
    )
    add(
        "Compatible dependency patch release",
        "compatible",
        "dependency_compatible",
        {
            "requirements.txt": "tiny==1.0",
            "tiny.py": "def encode(x): return str(x)",
            "client.py": "import tiny\ndef run(): return tiny.encode(1)",
        },
        {"requirements.txt": "tiny==1.1"},
        {"client.py": "import tiny\ndef run(): return tiny.encode(2)"},
        "dependency:tiny",
        "Local package API remains unchanged; pinned version metadata alone is not breakage.",
        'from pathlib import Path\nassert "1.1" in Path("requirements.txt").read_text()',
        'from client import run\nassert run()=="2"',
        witness={
            "requirements.txt": "tiny==1.1",
            "client.py": "import tiny\ndef run(): return tiny.encode(2)",
        },
    )
    add(
        "New keyword-only optional parameter",
        "compatible",
        "signature_compatible",
        {
            "api.py": "def get(x): return x",
            "client.py": "from api import get\ndef run(): return get(x=1)",
        },
        {"api.py": "def get(x, *, trace=False): return x"},
        {"client.py": "from api import get\ndef run(): return get(x=2)"},
        "api.py::get",
        "Caller uses an accepted keyword and does not need optional trace.",
        "from api import get\nassert get(3,trace=True)==3",
        "from client import run\nassert run()==2",
        witness={
            "api.py": "def get(x, *, trace=False): return x",
            "client.py": "from api import get\ndef run(): return get(x=2)",
        },
    )
    # Redundancy: some canonicalized, some intentionally outside the rule subset.
    add(
        "Equivalent None identity guards",
        "redundant",
        "null_equivalence",
        {"ops.py": "def value(x):\n    return x"},
        {"ops.py": "def value(x):\n    if x is None: return 0\n    return x"},
        {"ops.py": "def value(x):\n    if None is x: return 0\n    return x"},
        "ops.py::value",
        "Identity comparison operand reversal is equivalent.",
        "from ops import value\nassert value(None)==0 and value(2)==2",
        "from ops import value\nassert value(None)==0 and value(3)==3",
        online=True,
    )
    add(
        "Same logging edit",
        "redundant",
        "exact_duplicate",
        parse,
        {"parser.py": log},
        {"parser.py": log},
        "parser.py::parse",
        "Both patches add exactly the same single logging call.",
        cb,
        cb,
    )
    add(
        "Same default with different formatting",
        "redundant",
        "ast_equivalence",
        {"ops.py": "def f(x): return x"},
        {"ops.py": "def f(x=1): return x"},
        {"ops.py": "def f( x = 1 ):\n    return x"},
        "ops.py::f",
        "Whitespace differs, signatures and bodies are identical.",
        "from ops import f\nassert f()==1",
        "from ops import f\nassert f()==1",
    )
    add(
        "Equivalent conditional branches",
        "redundant",
        "null_equivalence",
        {"ops.py": "def f(x): return x"},
        {
            "ops.py": "def f(x):\n    if x is None:\n        return 0\n    else:\n        return x"
        },
        {
            "ops.py": "def f(x):\n    if x is not None:\n        return x\n    else:\n        return 0"
        },
        "ops.py::f",
        "Inverting the identity test and swapping return arms is equivalent.",
        "from ops import f\nassert f(None)==0 and f(4)==4",
        "from ops import f\nassert f(None)==0 and f(7)==7",
    )
    add(
        "Equivalent integer addition",
        "redundant",
        "algebraic_equivalence",
        {"ops.py": "def f(x: int): return x"},
        {"ops.py": "def f(x: int): return x+1"},
        {"ops.py": "def f(x: int): return 1+x"},
        "ops.py::f",
        "On the declared plain-integer domain addition commutes.",
        "from ops import f\nassert all(f(i)==i+1 for i in range(-10,11))",
        "from ops import f\nassert f(8)==9",
    )
    add(
        "Equivalent local variable rename",
        "redundant",
        "alpha_equivalence",
        {"ops.py": "def f(x): return x"},
        {"ops.py": "def f(x):\n    result=x*2\n    return result"},
        {"ops.py": "def f(x):\n    answer=x*2\n    return answer"},
        "ops.py::f",
        "Only the local temporary name differs.",
        "from ops import f\nassert f(3)==6",
        "from ops import f\nassert f(4)==8",
    )
    add(
        "Equivalent string format",
        "redundant",
        "format_equivalence",
        {"ops.py": "def greet(x: str): return x"},
        {"ops.py": 'def greet(x: str): return f"Hello {x}"'},
        {"ops.py": 'def greet(x: str): return "Hello {}".format(x)'},
        "ops.py::greet",
        "For string inputs the two formatting forms have identical output.",
        'from ops import greet\nassert greet("A")=="Hello A"',
        'from ops import greet\nassert greet("B")=="Hello B"',
    )
    add(
        "Duplicate dictionary field addition",
        "redundant",
        "exact_duplicate",
        {"api.py": 'def data(): return {"id":1}'},
        {"api.py": 'def data(): return {"id":1,"ok":True}'},
        {"api.py": 'def data(): return {"id":1,"ok":True}'},
        "api.py::data",
        "Both produce the same extended return contract.",
        'from api import data\nassert data()["ok"] is True',
        'from api import data\nassert data()=={"id":1,"ok":True}',
    )
    # Conflicting: 16 cases, cross-file dependencies plus expected hard failures.
    add(
        "Delete class versus extend class",
        "conflicting",
        "delete_extend",
        {"model.py": "class Foo:\n    def value(self): return 1"},
        {"model.py": "# Foo removed"},
        {
            "model.py": "class Foo:\n    def value(self): return 1\n    def extra(self): return 2"
        },
        "model.py::Foo",
        "A requires Foo absent while B requires its new method.",
        'import model\nassert not hasattr(model,"Foo")',
        "from model import Foo\nassert Foo().extra()==2",
        online=True,
    )
    add(
        "API rename versus new old-name consumer",
        "conflicting",
        "rename_use",
        {"api.py": "def fetch(): return 1", "client.py": "VALUE=1"},
        {"api.py": "def load(): return 1"},
        {"client.py": "from api import fetch\ndef run(): return fetch()+1"},
        "api.py::fetch",
        "B imports an API removed by A.",
        'import api\nassert api.load()==1 and not hasattr(api,"fetch")',
        "from client import run\nassert run()==2",
        online=True,
    )
    add(
        "Different functions share mutable scalar",
        "conflicting",
        "shared_state",
        {
            "state.py": "COUNT=0\ndef reset():\n    global COUNT\n    COUNT=0\ndef step():\n    global COUNT\n    COUNT+=1\n    return COUNT"
        },
        {
            "state.py": "COUNT=0\ndef reset():\n    global COUNT\n    COUNT=10\ndef step():\n    global COUNT\n    COUNT+=1\n    return COUNT"
        },
        {
            "state.py": "COUNT=0\ndef reset():\n    global COUNT\n    COUNT=0\ndef step():\n    global COUNT\n    assert COUNT<5\n    COUNT+=1\n    return COUNT"
        },
        "state.py::COUNT",
        "Reset changes state range; B assumes reset establishes a count below five.",
        "import state\nstate.reset()\nassert state.COUNT==10",
        "import state\nstate.reset()\nassert state.step()==1",
        online=True,
    )
    add(
        "Cross-file configuration unit",
        "conflicting",
        "shared_config",
        {
            "config.py": "TIMEOUT=5",
            "client.py": "from config import TIMEOUT\ndef seconds(): return TIMEOUT",
        },
        {"config.py": "TIMEOUT=5000"},
        {"client.py": "from config import TIMEOUT\ndef seconds(): return TIMEOUT*2"},
        "config.py::TIMEOUT",
        "A stores milliseconds while B continues using seconds.",
        "from config import TIMEOUT\nassert TIMEOUT==5000",
        "from client import seconds\nassert seconds()==10",
        online=True,
    )
    add(
        "Producer scalar to mapping",
        "conflicting",
        "return_contract",
        {
            "api.py": "def value(): return 3",
            "client.py": "from api import value\ndef run(): return value()",
        },
        {"api.py": 'def value(): return {"value":3}'},
        {"client.py": "from api import value\ndef run(): return value()+1"},
        "api.py::value",
        "Numeric consumer cannot add one to mapping return.",
        'from api import value\nassert value()=={"value":3}',
        "from client import run\nassert run()==4",
        online=True,
    )
    add(
        "Producer key rename",
        "conflicting",
        "return_contract",
        {
            "api.py": 'def user(): return {"name":"A"}',
            "client.py": 'from api import user\ndef label(): return user()["name"]',
        },
        {"api.py": 'def user(): return {"display":"A"}'},
        {
            "client.py": 'from api import user\ndef label(): return user()["name"].upper()'
        },
        "api.py::user",
        "Old key is absent in the new return mapping.",
        'from api import user\nassert "name" not in user() and user()["display"]=="A"',
        'from client import label\nassert label()=="A"',
    )
    add(
        "New required positional argument",
        "conflicting",
        "signature_break",
        {
            "api.py": "def scale(x): return x*2",
            "client.py": "from api import scale\ndef run(): return scale(1)",
        },
        {"api.py": "def scale(x, factor): return x*factor"},
        {"client.py": "from api import scale\ndef run(): return scale(3)"},
        "api.py::scale",
        "The new consumer call lacks the newly required factor.",
        "from api import scale\nassert scale(3,4)==12",
        "from client import run\nassert run()==6",
    )
    add(
        "Rename keyword argument",
        "conflicting",
        "signature_break",
        {
            "api.py": "def get(name): return name",
            "client.py": 'from api import get\ndef run(): return get(name="A")',
        },
        {"api.py": "def get(key): return key"},
        {"client.py": 'from api import get\ndef run(): return get(name="B")'},
        "api.py::get",
        "B passes a keyword no longer accepted by the producer.",
        'from api import get\nassert get(key="C")=="C"',
        'from client import run\nassert run()=="B"',
    )
    add(
        "Dependency removal invalidates import",
        "conflicting",
        "dependency_removal",
        {
            "requirements.txt": "tiny==1.0",
            "tiny.py": "def encode(x): return str(x)",
            "client.py": "VALUE=1",
        },
        {"requirements.txt": "# no dependencies", "tiny.py": None},
        {"client.py": "import tiny\ndef run(): return tiny.encode(2)"},
        "tiny.py::encode",
        "Bundled deterministic dependency fixture is removed; B adds a live import.",
        'from pathlib import Path\nassert not Path("tiny.py").exists()',
        'from client import run\nassert run()=="2"',
    )
    add(
        "Dependency upgrade changes local API",
        "conflicting",
        "dependency_upgrade",
        {
            "requirements.txt": "codec==1.0",
            "codec.py": "def encode(x): return str(x)",
            "client.py": "import codec\ndef run(): return codec.encode(1)",
        },
        {
            "requirements.txt": "codec==2.0",
            "codec.py": "def encode(x): return str(x).encode()",
        },
        {"client.py": 'import codec\ndef run(): return "value:"+codec.encode(2)'},
        "codec.py::encode",
        "Vendored dependency fixture now returns bytes, while consumer concatenates str.",
        'import codec\nassert codec.encode(1)==b"1"',
        'from client import run\nassert run()=="value:2"',
    )
    add(
        "Different replacement values",
        "conflicting",
        "write_write",
        {"config.py": 'MODE="base"'},
        {"config.py": 'MODE="fast"'},
        {"config.py": 'MODE="safe"'},
        "config.py::MODE",
        "One scalar cannot equal both required values.",
        'from config import MODE\nassert MODE=="fast"',
        'from config import MODE\nassert MODE=="safe"',
    )
    add(
        "Incompatible return semantics",
        "conflicting",
        "return_value",
        {"ops.py": "def fee(x): return x"},
        {"ops.py": "def fee(x): return x*2"},
        {"ops.py": "def fee(x): return x+2"},
        "ops.py::fee",
        "At x=3 the two required outputs are six and five.",
        "from ops import fee\nassert fee(3)==6",
        "from ops import fee\nassert fee(3)==5",
    )
    add(
        "Dynamic dispatch after rename",
        "conflicting",
        "dynamic_dispatch",
        {
            "api.py": "def fetch(): return 1",
            "client.py": 'import api\ndef run(): return getattr(api,"fetch")()',
        },
        {"api.py": "def load(): return 1"},
        {"client.py": 'import api\ndef run(): return getattr(api,"fetch")()+1'},
        "api.py::fetch",
        "String-based dynamic lookup still asks for removed API.",
        'import api\nassert api.load()==1 and not hasattr(api,"fetch")',
        "from client import run\nassert run()==2",
        online=True,
    )
    add(
        "Environment variable contract",
        "conflicting",
        "dynamic_configuration",
        {
            "producer.py": 'import os\ndef setup(): os.environ["APP_MODE"]="text"',
            "client.py": 'import os\ndef run(): return os.environ.get("APP_MODE")',
        },
        {"producer.py": 'import os\ndef setup(): os.environ["APP_MODE"]="binary"'},
        {
            "client.py": 'import os\ndef run():\n    assert os.environ.get("APP_MODE")=="text"\n    return "ok"'
        },
        "environment:APP_MODE",
        "Producer changes environment protocol consumed in a different module.",
        'import os\nfrom producer import setup\nsetup()\nassert os.environ["APP_MODE"]=="binary"',
        'from producer import setup\nfrom client import run\nsetup()\nassert run()=="ok"',
    )
    add(
        "JSON configuration consumer",
        "conflicting",
        "dynamic_configuration",
        {
            "config.json": '{"mode":"text"}',
            "client.py": 'import json\ndef read():\n    return json.load(open("config.json"))["mode"]',
        },
        {"config.json": '{"mode":"binary"}'},
        {
            "client.py": 'import json\ndef read():\n    mode=json.load(open("config.json"))["mode"]\n    assert mode=="text"\n    return mode.upper()'
        },
        "config.json::mode",
        "File-based dynamic dependency is not an import edge.",
        'import json\nassert json.load(open("config.json"))["mode"]=="binary"',
        'from client import read\nassert read()=="TEXT"',
    )
    add(
        "Shared string state protocol",
        "conflicting",
        "shared_state",
        {
            "state.py": 'MODE="text"\ndef setup():\n    global MODE\n    MODE="text"\ndef run(): return MODE'
        },
        {
            "state.py": 'MODE="text"\ndef setup():\n    global MODE\n    MODE="binary"\ndef run(): return MODE'
        },
        {
            "state.py": 'MODE="text"\ndef setup():\n    global MODE\n    MODE="text"\ndef run():\n    assert MODE=="text"\n    return MODE.upper()'
        },
        "state.py::MODE",
        "Changed writer violates another function's new state precondition.",
        'import state\nstate.setup()\nassert state.MODE=="binary"',
        'import state\nstate.setup()\nassert state.run()=="TEXT"',
    )
    return CASES


def patch(base, target):
    return "".join(
        "".join(
            difflib.unified_diff(
                base.get(p, "").splitlines(True),
                target.get(p, "").splitlines(True),
                fromfile="a/" + p if p in base else "/dev/null",
                tofile="b/" + p if p in target else "/dev/null",
            )
        )
        for p in sorted(base.keys() | target.keys())
        if base.get(p) != target.get(p)
    )


def write_state(root, state):
    for p, source in state.items():
        dest = root / p
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(source)


def build(root):
    root.mkdir(parents=True, exist_ok=True)
    for c in cases():
        path = root / c["id"]
        if path.exists():
            raise FileExistsError(f"Refusing to overwrite benchmark: {path}")
        path.mkdir()
        for key in ("base", "a", "b"):
            write_state(path / key, c[key])
        for key in ("a", "b"):
            (path / f"patch_{key.upper()}.diff").write_text(patch(c["base"], c[key]))
        (path / "checks").mkdir()
        for key, source in c["checks"].items():
            (path / "checks" / f"{key}.py").write_text(source)
        if c["witness"] is not None:
            write_state(path / "witness", c["witness"])
        metadata = {
            k: v
            for k, v in c.items()
            if k not in {"base", "a", "b", "checks", "witness"}
        }
        metadata["cross_file"] = not bool(
            {
                p
                for p in c["base"].keys() | c["a"].keys()
                if c["base"].get(p) != c["a"].get(p)
            }
            & {
                p
                for p in c["base"].keys() | c["b"].keys()
                if c["base"].get(p) != c["b"].get(p)
            }
        )
        metadata["witness_available"] = c["witness"] is not None
        (path / "gold.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n"
        )
        if c["online"]:
            # Three real source snapshots per branch: harmless helper, first changed
            # file, final state. Helpers remain until final cleanup. Steps
            # are syntactic and deterministic, not synthesized from gold labels.
            from ..online.sequences import stages, functional_complete

            events = []
            for index, (sa, sb) in enumerate(
                zip(stages(c["base"], c["a"], "a"), stages(c["base"], c["b"], "b")), 1
            ):
                for branch, snapshot in (("a", sa), ("b", sb)):
                    write_state(path / "online" / f"{branch}{index}", snapshot)
                    prev = (
                        c["base"]
                        if index == 1
                        else (stages(c["base"], c[branch], branch)[index - 2])
                    )
                    dest = path / "online" / f"{branch}{index}.diff"
                    dest.write_text(patch(prev, snapshot))
                    events.append(
                        {
                            "branch": branch,
                            "stage": index,
                            "state": f"{branch}{index}",
                            "patch": f"{branch}{index}.diff",
                            "requirements_active": functional_complete(
                                snapshot, c[branch]
                            ),
                        }
                    )
            (path / "online" / "schedule.json").write_text(
                json.dumps(events, indent=2) + "\n"
            )
    summary = {
        "cases": len(CASES),
        "labels": dict(Counter(c["label"] for c in CASES)),
        "families": dict(Counter(c["family"] for c in CASES)),
        "online_cases": sum(c["online"] for c in CASES),
    }
    (root / "statistics.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=Path("experiments/benchmark/cases"))
    build(parser.parse_args().out)
