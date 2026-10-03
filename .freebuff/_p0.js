// ---------------------------------------------------------------------------
// PHASE 0 — THE LANGUAGE LAYER
// One declarative table drives highlighting, brackets, snippets, symbols,
// breadcrumbs, diagnostics and AI context for 80+ languages. No compiler,
// no per-language extension required.
// ---------------------------------------------------------------------------
const K = s => new Set(String(s).split(/\s+/).filter(Boolean));
const PAIRS = { "{":"}", "(":")", "[":"]", "<":">" };
const OPENERS = ["{","(","[","\"","'","`"];

const FAM = {
  c:    { line:["//"], block:[["/*","*/"]], str:[['"','"'],["'","'"]], esc:true, pairs:PAIRS, ind:2, regexp:true },
  h:    { line:["#"],  str:[['"""','"""'],['"','"'],["'","'"]], esc:true, raw:['"""'], pairs:PAIRS, ind:4 },
  sql:  { line:["--"], block:[["/*","*/"]], str:[['"','"'],["'","'"]], esc:false, pairs:{}, ind:2 },
  lisp: { line:[";"],  str:[['"','"'],["'","'"]], esc:true, pairs:PAIRS, ind:2 },
  lua:  { line:["--"], str:[['[[',']]'],['"','"'],["'","'"]], esc:true, pairs:PAIRS, ind:2 },
  hs:   { line:["--"], block:[["{-","-}"]], str:[['"','"'],["'","'"]], esc:true, pairs:PAIRS, ind:2 },
  m:    { xml:true, str:[['"','"'],["'","'"]], esc:true, pairs:{}, ind:2 },
  vb:   { line:["'"],  str:[['"','"'],["'","'"]], esc:false, pairs:{}, ind:2 },
  pct:  { line:["%"],  str:[['"','"'],["'","'"]], esc:true, pairs:{}, ind:2 },
  scm:  { line:[";"],  str:[['"','"'],["'","'"]], esc:true, pairs:PAIRS, ind:2 },
  plain:{ str:[['"','"'],["'","'"]], pairs:{}, ind:2 },
  md:   { line:[], str:[], pairs:{}, ind:2, markdown:true },
};

// ---- symbol extraction recipes: [kind, regexSource, group]
const SYM = {
  py:   [["fn","^([ \\t]*)(?:async[ \\t]+)?def[ \\t]+([A-Za-z_]\\w*)",2],["cls","^([ \\t]*)class[ \\t]+([A-Za-z_]\\w*)",2],
         ["var","^([ \\t]*)([A-Z][A-Z0-9_]{2,})[ \\t]*=",2]],
  rb:   [["fn","^([ \\t]*)def[ \\t]+(?:self\\.)?([A-Za-z_]\\w*[!?=]?)",2],["cls","^([ \\t]*)class[ \\t]+([A-Za-z_]\\w*)",2],
         ["mod","^([ \\t]*)module[ \\t]+([A-Za-z_]\\w*)",2]],
  js:   [["fn","(?:^|[^\\w$.])(?:export[ \\t]+)?(?:default[ \\t]+)?(?:async[ \\t]+)?function[ \\t*]*([A-Za-z_$][\\w$]*)",1],
         ["cls","(?:^|[^\\w$.])(?:export[ \\t]+)?(?:abstract[ \\t]+)?class[ \\t]+([A-Za-z_$][\\w$]*)",1],
         ["var","(?:^|\\n)[ \\t]*(?:export[ \\t]+)?(?:const|let|var)[ \\t]+([A-Za-z_$][\\w$]*)",1],
         ["fn","(?:^|\\n)[ \\t]*(?:export[ \\t]+)?(?:const|let|var)[ \\t]+([A-Za-z_$][\\w$]*)[ \\t]*=[ \\t]*(?:async[ \\t]*)?(?:function|\\([^)]*\\)[ \\t]*=>|[A-Za-z_$][\\w$]*[ \\t]*=>)",1],
         ["fn","(?:^|[^\\w$.])(?:export[ \\t]+)?(?:const|let|var)[ \\t]*\\{([^}]*)\\}[ \\t]*=[ \\t]*(?:async[ \\t]*)?function",1]],
  ts:   [["int","(?:^|\\n)[ \\t]*(?:export[ \\t]+)?(?:declare[ \\t]+)?(?:interface|type|enum)[ \\t]+([A-Za-z_$][\\w$]*)",1],
         ["cls","(?:^|[^\\w$.])(?:export[ \\t]+)?(?:abstract[ \\t]+)?class[ \\t]+([A-Za-z_$][\\w$]*)",1],
         ["fn","(?:^|[^\\w$.])(?:export[ \\t]+)?(?:async[ \\t]+)?function[ \\t*]*([A-Za-z_$][\\w$]*)",1],
         ["var","(?:^|\\n)[ \\t]*(?:export[ \\t]+)?(?:const|let|var)[ \\t]+([A-Za-z_$][\\w$]*)",1]],
  jvm:  [["cls","(?:^|[^\\w$.])((?:public|private|protected|static|final|abstract|sealed|open|internal|override|suspend)[ \\t]+)+(?:class|interface|enum|record|object)[ \\t]+([A-Za-z_]\\w*)",2],
         ["fn","(?:^|[^\\w$.])((?:public|private|protected|static|final|abstract|override|suspend|inline|operator)[ \\t]+)*[\\w<>\\[\\],. ?]+[ \\t]+([A-Za-z_]\\w*)[ \\t]*\\(",2],
         ["int","(?:^|\\n)[ \\t]*((?:public|private|protected|static|final|abstract)[ \\t]+)*(?:interface|enum|record)[ \\t]+([A-Za-z_]\\w*)",2]],
  c:    [["prm","^([ \\t]*#[ \\t]*define[ \\t]+)([A-Za-z_]\\w*)",2],
         ["fn","^[A-Za-z_][\\w \\t\\*]*?([A-Za-z_]\\w*)[ \\t]*\\([^;]*\\)[ \\t]*\\{",1],
         ["int","^[ \\t]*(?:typedef[ \\t]+)?(?:struct|enum|union)[ \\t]+([A-Za-z_]\\w*)",1]],
  rust: [["fn","^[ \\t]*(?:pub(?:\\([^)]*\\))?[ \\t]+)?(?:async[ \\t]+)?(?:unsafe[ \\t]+)?(?:extern[ \\t]+\"[^\"]+\"[ \\t]+)?fn[ \\t]+([A-Za-z_]\\w*)",1],
         ["int","^[ \\t]*(?:pub(?:\\([^)]*\\))?[ \\t]+)?(?:struct|enum|trait|union|type|mod)[ \\t]+([A-Za-z_]\\w*)",1],
         ["int","^[ \\t]*impl(?:<[^>]*>)?[ \\t]+([A-Za-z_][\\w:]*)",1],
         ["var","^[ \\t]*macro_rules![ \\t]+([A-Za-z_]\\w*)",1]],
  go:   [["fn","^[ \\t]*func[ \\t]+(?:\\([^)]*\\)[ \\t]*)?([A-Za-z_]\\w*)",1],
         ["fn","^[ \\t]*func[ \\t]+([A-Za-z_]\\w*)",1],
         ["int","^[ \\t]*type[ \\t]+([A-Za-z_]\\w*)",1]],
  sh:   [["fn","^[ \\t]*(?:function[ \\t]+)?([A-Za-z_]\\w*)[ \\t]*\\(\\)[ \\t]*\\{",1],
         ["var","^([ \\t]*(?:export[ \\t]+|local[ \\t]+|declare[ \\t]+)?)([A-Za-z_]\\w*)=",2]],
  lua:  [["fn","^[ \\t]*(?:local[ \\t]+)?function[ \\t]+([A-Za-z_.:]+)",1],
         ["var","^[ \\t]*local[ \\t]+([A-Za-z_]\\w*)[ \\t]*=",1]],
  php:  [["cls","(?:^|\\n)[ \\t]*(?:final[ \\t]+|abstract[ \\t]+)?(?:class|interface|trait)[ \\t]+([A-Za-z_]\\w*)",1],
         ["fn","(?:^|[^\\w$.])function[ \\t]+([A-Za-z_]\\w*)",1],
         ["var","(?:^|\\n)[ \\t]*\\$([A-Za-z_]\\w*)[ \\t]*=",1]],
  swift:[["fn","(?:^|\\n)[ \\t]*(?:public[ \\t]+|private[ \\t]+|internal[ \\t]+|fileprivate[ \\t]+|open[ \\t]+|static[ \\t]+|final[ \\t]+|override[ \\t]+|mutating[ \\t]+)*(?:func)[ \\t]+([A-Za-z_]\\w*)",1],
         ["cls","(?:^|\\n)[ \\t]*(?:public[ \\t]+|private[ \\t]+|internal[ \\t]+|fileprivate[ \\t]+|open[ \\t]+|final[ \\t]+)*(?:class|struct|enum|protocol|extension|typealias)[ \\t]+([A-Za-z_]\\w*)",1],
         ["var","(?:^|\\n)[ \\t]*(?:public[ \\t]+|private[ \\t]+|internal[ \\t]+|static[ \\t]+|let[ \\t]+|var[ \\t]+)([A-Za-z_]\\w*)[ \\t]*:",1]],
  kt:   [["cls","(?:^|\\n)[ \\t]*(?:public[ \\t]+|private[ \\t]+|internal[ \\t]+|open[ \\t]+|abstract[ \\t]+|sealed[ \\t]+|data[ \\t]+)*(?:class|interface|object|enum class)[ \\t]+([A-Za-z_]\\w*)",1],
         ["fn","(?:^|\\n)[ \\t]*(?:public[ \\t]+|private[ \\t]+|internal[ \\t]+|open[ \\t]+|override[ \\t]+|suspend[ \\t]+|inline[ \\t]+)*(?:fun)[ \\t]+([A-Za-z_]\\w*)",1],
         ["var","(?:^|\\n)[ \\t]*(?:val|var)[ \\t]+([A-Za-z_]\\w*)",1]],
  cs:   [["cls","(?:^|\\n)[ \\t]*((?:public|private|protected|internal|static|sealed|abstract|partial|record)[ \\t]+)*(?:class|interface|struct|enum|record)[ \\t]+([A-Za-z_]\\w*)",2],
         ["fn","(?:^|\\n)[ \\t]*((?:public|private|protected|internal|static|async|virtual|override|sealed)[ \\t]+)+[\\w<>\\[\\],.?]+[ \\t]+([A-Za-z_]\\w*)[ \\t]*\\(",2]],
  dart: [["cls","(?:^|\\n)[ \\t]*(?:abstract[ \\t]+)?class[ \\t]+([A-Za-z_]\\w*)",1],
         ["fn","(?:^|\\n)[ \\t]*(?:static[ \\t]+)?(?:[\\w<>?]+[ \\t]+)?([A-Za-z_]\\w*)[ \\t]*\\([^)]*\\)[ \\t]*(?:async[ \\t]*)?\\{",1]],
  scala:[["cls","(?:^|\\n)[ \\t]*(?:(?:final|sealed|abstract|case|implicit|private|protected)[ \\t]+)*(?:class|object|trait|enum)[ \\t]+([A-Za-z_]\\w*)",1],
         ["fn","(?:^|\\n)[ \\t]*(?:private[ \\t]+|override[ \\t]+)?def[ \\t]+([A-Za-z_]\\w*)",1]],
  r:    [["fn","\\b([A-Za-z_.][\\w.]*)[ \\t]*(?:<-|=)[ \\t]*function[ \\t]*\\(",1],
         ["var","^([A-Za-z_.][\\w.]*)[ \\t]*(?:<-|=)[ \\t]*(?!function)",1]],
  mat:  [["fn","^[ \\t]*function[ \\t]+([^\\n(]+)",1],["var","^([ \\t]*)([A-Za-z_]\\w*)[ \\t]*=",2]],
  jul:  [["fn","^[ \\t]*(?:function|macro)[ \\t]+([A-Za-z_]\\w*)",1],
         ["int","^[ \\t]*(?:abstract[ \\t]+)?(?:mutable[ \\t]+)?struct[ \\t]+([A-Za-z_]\\w*)",1],
         ["fn","^[ \\t]*([A-Za-z_]\\w*)[ \\t]*\\([^)]*\\)[ \\t]*(?:where[ \\n\\S]*?)?=",1]],
  hs:   [["fn","^([ \\t]*)([A-Za-z_]\\w*)[ \\t]*::",2],["int","^(?:data[ \\t]+|newtype[ \\t]+|type[ \\t]+|class[ \\t]+)?([A-Z]\\w*)[ \\t]*(?:\\(|=|;|$)",1]],
  erl:  [["fn","^([ \\t]*)([a-z][\\w@]*)[ \\t]*\\(",2]],
  ex:   [["fn","^([ \\t]*)def(?:p)?[ \\t]+([A-Za-z_][\\w!?]*)",2],["mod","^([ \\t]*)defmodule[ \\t]+([A-Za-z_.]+)",2]],
  zig:  [["fn","^[ \\t]*(?:pub[ \\t]+)?fn[ \\t]+([A-Za-z_]\\w*)",1]],
  nim:  [["fn","^[ \\t]*(?:proc|func|method|iterator|template|macro)[ \\t]+([A-Za-z_]\\w*)",1],["int","^[ \\t]*type[ \\t]+([A-Za-z_]\\w*)",1]],
  sol:  [["fn","^[ \\t]*(?:function|constructor)[ \\t]+([A-Za-z_]\\w*)",1],
         ["int","^(?:contract|library|interface)[ \\t]+([A-Za-z_]\\w*)",1],
         ["fn","^[ \\t]*(?:event|modifier|fallback|receive)[ \\t]+([A-Za-z_]\\w*)",1]],
  elm:  [["fn","^([ \\t]*)([a-z]\\w*)[ \\t]*:.*->",2],["int","^([ \\t]*)(type alias)[ \\s\\S]*?^([ \\t]*)type[ \\t]+([A-Z]\\w*)",3]],
  ocaml:[["let","^([ \\t]*)(?:let[ \\t]+(?:rec[ \\t]+)?)([A-Za-z_]\\w*)",2],["ty","^([ \\t]*)(type[ \\t]+)([a-z]\\w*)",2]],
  clj:  [["fn","^\\(\\s*defn?-?\\s+([A-Za-z_\\-*+!?<>=/.$%&|]+)",1],["fn","^\\(\\s*([A-Za-z_\\-*+!?<>=/.$%&|]+)",1]],
  elm2:[],
  ml:   [["fn","^[ \\t]*(?:let|and)[ \\t]+([a-z_][\\w']*)",1],["int","^[ \\t]*type[ \\t]+([a-z_][\\w']*)",1]],
  groovy:[["cls","(?:^|\\n)[ \\t]*(?:public|final|abstract|static)*[ \\t]*(?:class|interface|trait|enum)[ \\t]+([A-Za-z_]\\w*)",1],
         ["fn","(?:^|\\n)[ \\t]*(?:public|private|protected|static|def)[ \\t]+([A-Za-z_]\\w*)[ \\t]*\\(",1]],
  objc: [["fn","^[ \\t]*[-+]\\s*\\([^)]*\\)\\s*([A-Za-z_]\\w*)",1]],
  asm:  [["fn","^[ \\t]*([A-Za-z_.$][\\w.$]*):",1]],
  abap: [["fn","^[ \\t]*(?:METHODS|FORM|PROCEDURE)[ \\t]+([A-Za-z_/]\\w*)",1]],
  pas:  [["fn","^[ \\t]*(?:function|procedure|constructor|destructor)[ \\t]+([A-Za-z_]\\w*)",1],
         ["int","^[ \\t]*(?:type|unit)[ \\t]+([A-Za-z_]\\w*)",1]],
  for:  [["fn","^[ \\t]*program[ \\t]+([A-Za-z_]\\w*)",1],
         ["fn","^[ \\t]*(?:integer|real|logical|character|double[ \\t]+precision|subroutine[ \\t]+[a-z]+)[ \\t]+function[ \\t]+([A-Za-z_]\\w*)",1]],
  cob:  [["fn","^([ \\t]*)([A-Za-z-]+?)[ \\t]+(?:PIC|SECTION|DIVISION)",2]],
  adb:  [["fn","^([ \\t]*)(?:local[ \\t]+)?function[ \\t]+([A-Za-z_]\\w*)",2],["proc","^([ \\t]*)(?:package[ \\t]+body)[ \\s\\S]*?^([ \\t]*)([A-Za-z_]\\w*)[ \\t]*\\(.*\\)[ \\t]*(?:is|as)[ \\s\\S]*?\\1end[ \\t]+\\2",2]],
  vhdl:[["fn","^([ \\t]*)(?:entity|architecture|component|package)[ \\s\\S]*?^([ \\t]*)([A-Za-z_]\\w*)[ \\s\\S]*?^\\1is",3]],
  verilog:[["fn","^[ \\t]*(?:function|task)[ \\t]+(?:automatic[ \\t]+)?([A-Za-z_]\\w*)",1],["mod","^[ \\t]*module[ \\t]+([A-Za-z_]\\w*)",1]],
  txt:  [],
};// ---- keyword / builtin / type / constant vocabularies
const KW = {
  js: "break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await get set of from as public private protected implements interface enum abstract declare namespace module",
  ts: "break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await abstract as asserts implements interface is keyof namespace readonly satisfies type enum infer module declare",
  py: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self cls",
  java:"abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try var void volatile while record sealed permits yield",
  c:  "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false NULL",
  cpp:"alignas alignof and asm auto bool break case catch char char8_t char16_t char32_t class concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while",
  cs: "abstract as base bool break byte case catch char checked class const continue decimal default delegate do double dynamic else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while yield async await record required init",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false string int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 byte rune float32 float64 bool error any",
  rust:"as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while box i8 i16 i32 i64 u8 u16 u32 u64 usize f32 f64 bool char str String Vec Option Result Some None Ok Err",
  rb:  "BEGIN END alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield attr_accessor attr_reader attr_writer require require_relative puts",
  php: "abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false null int string float bool void iterable object mixed never",
  swift:"associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as Any catch false is nil rethrows self Self super throw throws true try",
  kt:  "abstract actual annotation as break by catch class companion const constructor continue crossinline data delegate do dynamic else enum expect external final finally for fun get if import in infix init inline inner interface internal is lateinit noinline null object open operator out override package private protected public reified return sealed set super suspend tailrec this throw try typealias typeof val var vararg when where while yield",
  scala:"abstract case catch class def do else extends false final finally for forSome if implicit import lazy match new null object override package private protected return sealed super this throw trait try true type val var while with yield",
  dart: "abstract as assert async await break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for get hide if implements import in interface is late library mixin new null on operator part required rethrow return sealed set show static super switch sync this throw true try typedef var void while with yield",
  php2:"",
  hs:  "case class data default deriving do else foreign if import in infix infixl infixr instance let module newtype of then type where forall mdo proc rec family role pattern static group by using qualified",
  lua: "and break do else elseif end false for function goto if in local nil not or repeat return then true until while",
  sh:  "if then else elif fi case esac for while until do done in function select time case esac return export local readonly declare shift source alias unalias trap set unset",
  ex:  "def defp defmodule defmacro defstruct defpprotocol defimpl use import require alias require import quote unquote sigil when with for cond case receive try rescue catch after else raise throw defdelegate defguard defprotocol",
  r:   "if else repeat while function for next break TRUE FALSE NULL Inf NaN NA library require source c list vector data.frame matrix factor",
  jl:  "function end if elseif else for while break continue return struct mutable abstract type where begin let quote in isa import using module export public baremodule",
  rs:  "fn let mut struct enum impl trait use mod pub crate match if else loop for while return const static type where as ref dyn unsafe async await move box Self super",
  ml:  "fun let rec and in end type val of ref with exception raise try handle open struct signature functor when",
  clj: "defn defn- def defmacro defmulti defmethod defprotocol defrecord deftype let letfn if when when-not cond case do comment ns import require use recur loop for doseq dotool fn quote var set! binding",
  kt2: "",
  erl: "-module -export -record -spec -type -define -include",
  nim: "proc func method iterator template macro type var let const result object ref ptr seq",
  zig: "const var fn pub usingnamespace struct enum union test defer comptime errdefer if switch while for orelse try catch unreachable",
  sol: "pragma import library contract interface constructor function event modifier fallback receive returns returns emit using for struct mapping enum error require",
  raku: "sub method class role grammar token rule has is does unit module package constant my our state submethod multi",
  for: "program end subroutine function module use implicit none integer real dimension parameter contains stop",
  cob:  "IDENTIFICATION DIVISION PROGRAM-ID ENVIRONMENT-DATA CONFIGURATION-SOURCE DATA WORKING-STORAGE PROCEDURE DIVISION DISPLAY STOP RUN PIC VALUE.",
  pas: "begin end program unit uses var const type function procedure record class object interface implementation constructor destructor property private public inherited",
  abap: "DATA TYPES BEGIN OF END OF FORM IF ELSE ELSEIF ENDIF LOOP ENDLOOP DO WHILE WHEN CASE ENDCASE METHOD METHODS CLASS ENDCLASS REPORT SELECT ENDSELECT",
  verilog:"module endmodule input output inout wire reg always always_ff always_comb initial begin end assign parameter localparam generate endgenerate if else case endcase function endfunction task endtask",
  asm:  "mov push pop call ret jmp je jne cmp add sub lea nop int xor",
  vhdl:"entity architecture is port map signal process begin end component of downto to in out inout type subtype function procedure variable constant",
  adb: "with Ada.Text_IO use package body procedure function is record type begin end loop if then else return pragma",
  vb:  "Dim Sub Function Class Module If Then Else For Each Next While End Select Case New Me Return Public Private Friend Property End Module",
  objc:"@interface @implementation @end @property @synthesize @dynamic @protocol @selector @class @public @private @protected @autoreleasepool instancetype nonatomic atomic strong weak copy assign readonly",
  powershell:"function param begin process end if else elseif foreach for while do switch return class enum filter where select foreach-object write-output write-host",
  batch:"set call goto if else for in do exit not exist defined errorlevel equ goto eof rem",
  make:"ifeq ifneq ifdef ifndef else endif include define endef export unexport vpath .PHONY",
  cmake:"if elseif else endif foreach endforeach function endfunction macro endmacro set list string file add_executable add_library target_sources include_directories",
  tex:  "documentclass usepackage begin end document section subsection subsubsection chapter item label ref cite includegraphics newcommand renewcommand textbf textit",
  org:  "#+TITLE #+AUTHOR #+OPTIONS * heading",
  csv:  "",
};
const BUILTINS = {
  js: "console window document Math JSON Object Array String Number Boolean Promise Map Set WeakMap WeakSet Symbol Date RegExp Error parseInt parseFloat isNaN isFinite setTimeout setInterval clearTimeout clearInterval fetch localStorage sessionStorage require module exports globalThis process Buffer require process URL URLSearchParams TextEncoder TextDecoder queueMicrotask structuredClone super",
  py: "print len range enumerate zip map filter sorted sum min max abs round open input int float str bool list dict set tuple type isinstance issubclass super getattr setattr hasattr repr format any all dir vars id hash iter next slice reversed divmod pow chr ord bin hex oct callable staticmethod classmethod property Exception ValueError TypeError KeyError IndexError AttributeError RuntimeError NotImplementedError StopIteration self cls",
  rb: "puts print p pp require require_relative attr_accessor attr_reader attr_writer lambda proc loop new freeze nil raise rescue begin ensure self",
  java:"System out println print String Integer Long Double Float Boolean Math List ArrayList Map HashMap Set HashSet Stream Optional Objects Arrays Collections Exception RuntimeException Thread Runnable",
  c:  "printf scanf malloc calloc realloc free memcpy memset strlen strcpy strcmp fopen fclose fgets fputs fprintf sprintf sqrt pow abs rand srand exit malloc",
  cpp:"std cout cin endl string vector map set unordered_map unique_ptr shared_ptr nullptr std::move std::forward make_unique make_shared",
  go: "fmt Println Printf Sprintf Errorf Error New Reader Writer String Len Cap Make Append Copy Close Scan os io bufio http json time strconv strings sync context errors reflect sort",
  rust:"println! print! eprintln! format! vec! String Vec Option Result Some None Ok Err Box Rc Arc RefCell Cell HashMap HashSet std::mem std::fmt",
  sh:  "echo cd ls cat grep sed awk cut tr sort uniq head tail wc find xargs rm cp mv mkdir chmod chown curl wget git python python3 node npm pip apt sudo export source exit set test read local return",
  lua: "print type pairs ipairs table string math io os require tonumber tostring pcall error assert select unpack rawget rawset setmetatable getmetatable",
  php: "echo print count strlen str_replace array_map array_filter implode explode json_encode json_decode var_dump isset empty is_array is_null in_array",
  swift:"print String Int Double Bool Array Dictionary Set Optional UIKit Foundation SwiftUI View Text func let var guard if",
  r:   "c list print paste apply sapply lapply vapply mapply filter map reduce summary head tail",
  jl:  "println print length size push! pop! zeros ones rand Array Vector Dict String Int Float println push! zeros",
  ex:  "IO IO.inspect Kernel defmodule defstruct use",
  sql: "SELECT FROM WHERE INSERT UPDATE DELETE CREATE DROP ALTER TABLE INDEX VIEW JOIN LEFT RIGHT INNER OUTER FULL ON GROUP BY ORDER HAVING LIMIT OFFSET UNION ALL DISTINCT AS AND OR NOT NULL IS IN BETWEEN LIKE EXISTS CASE WHEN THEN ELSE END PRIMARY KEY FOREIGN REFERENCES DEFAULT CONSTRAINT VALUES SET INTO COUNT SUM AVG MIN MAX COALESCE",
  html:"",
};
const TYPES = {
  ts: "string number boolean any unknown never void object symbol bigint Record Partial Required Readonly Pick Omit Map Set Promise Array",
  java:"String Integer Long Double Float Boolean Object List Map Set ArrayList HashMap Exception byte short char int long float double void boolean",
  c:  "int char long short float double void size_t ssize_t int8_t int32_t int64_t uint8_t bool FILE va_list",
  cpp:"int char long short float double void bool auto std string vector map size_t uint8_t",
  go: "int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 byte rune float32 float64 bool error string any struct interface map chan",
  rust:"i8 i16 i32 i64 u8 u16 u32 u64 usize isize f32 f64 bool char str String Vec Option Result Box Rc Arc",
  ts2:"",
  swift:"String Int Double Float Bool Array Dictionary Set Character Any AnyObject",
  kt:  "String Int Double Float Boolean Long Byte Short Char ArrayList List MutableList Set Map Unit Nothing",
  cs:  "string int long bool double float decimal object byte char var dynamic List Dictionary Task",
  rb:  "String Integer Float Array Hash Symbol Range Proc Struct Class Module Kernel",
  py:  "int float str bool list dict set tuple bytes object None Exception",
};
const CONSTS = {
  js: "true false null undefined NaN Infinity globalThis",
  py: "True False None NotImplemented Ellipsis __name__ __main__ __file__",
  java:"true false null",
  go: "true false nil iota",
  rust:"true false None Some Ok Err",
  c:  "true false NULL",
  cpp:"true false nullptr",
  rb:  "true false nil __FILE__ __LINE__",
  sh:  "true false",
  lua: "true false nil",
  swift:"true false nil",
};// ---- the language table. One row per language; families supply the syntax,
// keywords/builtins/types supply meaning. Adding a language = adding a row.
const LANGS = [
  // id            name            ext                              fam    sym   kw     bi     ty    run
  ["javascript",  "JavaScript",   "js mjs cjs jsx",                 "c",   "js",  "js",  "js",  "js",  "js"],
  ["typescript",  "TypeScript",   "ts tsx mts cts",                 "c",   "ts",  "ts",  "js",  "ts",  "ts"],
  ["python",      "Python",       "py pyw pyi ipynb",               "h",   "py",  "py",  "py",  "py",  "py"],
  ["java",        "Java",         "java",                           "c",   "jvm", "java","java","java","java"],
  ["kotlin",      "Kotlin",       "kt kts",                         "c",   "kt",  "kt",  "",    "kt",  "kotlin"],
  ["scala",       "Scala",        "scala sc",                       "c",   "scala","scala","",  "",    "scala"],
  ["groovy",      "Groovy",       "groovy gvy",                     "c",   "groovy","php","",  "",    "groovy"],
  ["c",           "C",            "c h",                            "c",   "c",   "c",   "c",   "c",   "gcc"],
  ["cpp",         "C++",          "cpp cxx cc hpp hxx ipp",         "c",   "c",   "cpp", "cpp", "cpp", "g++"],
  ["csharp",      "C#",           "cs csx",                         "c",   "cs",   "cs",  "",    "cs",  "dotnet"],
  ["fsharp",      "F#",           "fs fsi fsx",                     "c",   "txt",  "txt",  "",    "",    "dotnet"],
  ["vb",          "Visual Basic", "vb vbs",                         "vb",  "txt",  "vb",  "",    "",    ""],
  ["objectivec",  "Objective-C",  "m mm",                           "c",   "objc", "objc","",    "",    ""],
  ["dart",        "Dart",         "dart",                           "c",   "dart", "dart","",    "",    "dart"],
  ["swift",       "Swift",        "swift",                          "c",   "swift","swift","",   "swift","swift"],
  ["go",          "Go",           "go",                             "c",   "go",   "go",  "go",  "go",  "go"],
  ["rust",        "Rust",         "rs",                             "c",   "rust", "rust","rust","rust","cargo"],
  ["zig",         "Zig",          "zig",                            "c",   "zig",  "zig", "",    "",    "zig"],
  ["julia",       "Julia",        "jl",                             "h",   "jul",  "jl",  "jl",  "",    "julia"],
  ["r",           "R",            "r rmd R",                        "h",   "r",    "r",   "r",   "",    "Rscript"],
  ["matlab",      "MATLAB",       "m mat",                          "h",   "mat",  "txt", "",    "",    "matlab"],
  ["octave",      "Octave",       "oct",                            "h",   "mat",  "txt", "",    "",    "octave"],
  ["ruby",        "Ruby",         "rb rake gemfile gemspec",        "h",   "rb",   "rb",  "rb",  "rb",  "ruby"],
  ["perl",        "Perl",         "pl pm t",                        "h",   "txt",  "txt", "",    "",    "perl"],
  ["raku",        "Raku",         "raku rakumod p6",                "h",   "txt",  "raku","",    "",    "raku"],
  ["php",         "PHP",          "php php3 php4 php5 phtml",       "c",   "php",  "php", "php", "",    "php"],
  ["lua",         "Lua",          "lua",                            "lua", "lua",  "lua", "lua", "",    "lua"],
  ["tcl",         "Tcl",          "tcl tk",                         "h",   "txt",  "txt", "",    "",    "tclsh"],
  ["bash",        "Bash",         "sh bash zsh ksh",                "h",   "sh",   "sh",  "sh",  "",    "bash"],
  ["fish",        "Fish",         "fish",                           "h",   "sh",   "sh",  "sh",  "",    "fish"],
  ["powershell",  "PowerShell",   "ps1 psm1 psd1",                  "h",   "txt",  "powershell","", "", "pwsh"],
  ["batch",       "Batch",        "bat cmd",                        "vb",  "txt",  "batch","",  "",    ""],
  ["sql",         "SQL",          "sql ddl dml",                    "sql", "txt",  "sql", "sql", "",    ""],
  ["html",        "HTML",         "html htm xhtml",                 "m",   "txt",  "",    "",    "",    "html"],
  ["xml",         "XML",          "xml svg xaml plist rss atom",    "m",   "txt",  "",    "",    "",    "xml"],
  ["vue",         "Vue",          "vue",                            "m",   "txt",  "js",  "js",  "js",  "js"],
  ["svelte",      "Svelte",       "svelte",                         "m",   "txt",  "js",  "js",  "js",  "js"],
  ["css",         "CSS",          "css scss sass less styl",        "c",   "txt",  "css", "css", "",    "css"],
  ["json",        "JSON",         "json jsonc json5 geojson",       "c",   "json", "",    "",    "",    "json"],
  ["json5",       "JSON5",        "",                               "c",   "json", "",    "",    "",    "json"],
  ["yaml",        "YAML",         "yml yaml",                       "h",   "yaml", "yaml","yaml","",    ""],
  ["toml",       "TOML",         "toml",                           "h",   "txt",  "toml","",    "",    ""],
  ["ini",         "INI",          "ini cfg conf properties editorconfig", "h", "txt", "txt", "", "", ""],
  ["env",         "Dotenv",       "env",                            "h",   "txt",  "",    "",    "",    ""],
  ["markdown",    "Markdown",     "md markdown mdx rst adoc",        "md",  "md",   "",    "",    "",    "md"],
  ["tex",         "LaTeX",        "tex latex sty cls bib",          "pct", "txt",  "tex", "",    "",    "latex"],
  ["rst",         "reStructured", "rst",                            "pct", "txt",  "",    "",    "",    ""],
  ["asm",         "Assembly",     "asm s S nasm",                   "pct", "asm",  "asm", "asm", "",    ""],
  ["wat",         "WebAssembly",  "wat wasm",                       "lisp","txt",  "",    "",    "",    ""],
  ["lisp",        "Lisp",         "lisp lisp scm el cl ss rkt",     "lisp","clj",  "lisp","",    "",    ""],
  ["clojure",     "Clojure",      "clj cljs cljc edn",              "lisp","clj",  "clj", "",    "",    ""],
  ["scheme",      "Scheme",       "scm ss",                         "lisp","txt",  "lisp","",    "",    ""],
  ["racket",      "Racket",       "rkt",                            "lisp","txt",  "lisp","",    "",    ""],
  ["haskell",     "Haskell",      "hs lhs",                         "hs",  "hs",   "hs",  "hs",  "",    ""],
  ["purescript",  "PureScript",   "purs",                           "hs",  "hs",   "hs",  "hs",  "",    ""],
  ["elm",         "Elm",          "elm",                            "hs",  "elm",  "",    "",    "",    ""],
  ["ocaml",       "OCaml",        "ml mli",                         "hs",  "ocaml","txt", "",    "",    ""],
  ["fsharp2",     "F#",           "",                               "hs",  "txt",  "txt", "",    "",    ""],
  ["reason",      "ReasonML",     "re rei",                         "hs",  "txt",  "txt", "",    "",    ""],
  ["erlang",      "Erlang",       "erl hrl escript",                "pct", "erl",  "erl", "",    "",    "escript"],
  ["elixir",      "Elixir",       "ex exs eex leex heex",           "h",   "ex",   "ex",  "ex",  "",    "mix"],
  ["nim",         "Nim",          "nim nims",                       "h",   "nim",  "nim", "",    "",    "nim"],
  ["crystal",     "Crystal",      "cr",                             "h",   "rb",   "rb",  "rb",  "",    "crystal"],
  ["solidity",    "Solidity",     "sol",                            "c",   "sol",  "sol", "",    "",    ""],
  ["move",        "Move",         "move",                           "c",   "txt",  "txt", "",    "",    ""],
  ["cairo",       "Cairo",        "cairo",                          "c",   "txt",  "txt", "",    "",    ""],
  ["zig2",        "Zig",          "",                               "c",   "zig",  "zig", "",    "",    ""],
  ["vbnet",       "VB.NET",       "",                               "vb",  "txt",  "txt", "",    "",    ""],
  ["pascal",      "Pascal",       "pas dpr lpr pp",                 "pct", "pas",  "pas", "pas", "",    ""],
  ["fortran",     "Fortran",      "f90 f95 f03 f08 for",            "scm", "for",  "for", "for", "",    ""],
  ["cobol",       "COBOL",        "cob cbl cpy",                    "scm", "cob",  "cob", "cob", "",    ""],
  ["ada",         "Ada",          "adb ads",                        "h",   "adb",  "adb", "adb", "",    ""],
  ["vhdl",        "VHDL",         "vhd vhdl",                       "lisp","vhdl", "vhdl","vhdl","",    ""],
  ["verilog",     "Verilog",      "v sv svh",                       "c",   "verilog","verilog","","", ""],
  ["systemverilog","SystemVerilog","svh",                           "c",   "verilog","verilog","","", ""],
  ["tla",         "TLA+",         "tla cfg",                        "pct", "txt",  "",    "",    "",    ""],
  ["abap",        "ABAP",         "abap",                           "scm", "abap", "abap","",    "",    ""],
  ["apex",        "Apex",         "cls trigger",                    "c",   "txt",  "jvm", "jvm", "",    ""],
  ["make",        "Makefile",     "mk mak makefile",                "h",   "txt",  "make","",    "",    "make"],
  ["cmake",       "CMake",        "cmake",                          "h",   "txt",  "cmake","",   "",    "cmake"],
  ["dockerfile",  "Dockerfile",   "dockerfile containerfile",       "h",   "txt",  "sh",  "sh",  "",    "docker"],
  ["nginx",       "Nginx",        "nginx conf",                     "h",   "txt",  "",    "",    "",    ""],
  ["apache",      "Apache",       "htaccess htpasswd",              "h",   "txt",  "",    "",    "",    ""],
  ["graphql",     "GraphQL",      "graphql gql",                    "h",   "txt",  "sql", "",    "",    ""],
  ["proto",       "Protocol Buf", "proto",                          "c",   "txt",  "java","java","java",""],
  ["thrift",      "Thrift",       "thrift",                         "c",   "txt",  "txt", "",    "",    ""],
  ["capnp",       "Cap'n Proto",  "capnp",                          "c",   "txt",  "",    "",    "",    ""],
  ["regex",       "RegExp",       "regex regexp",                   "pct", "txt",  "",    "",    "",    ""],
  ["diff",        "Diff",         "diff patch",                     "scm", "txt",  "",    "",    "",    ""],
  ["log",         "Log",          "log",                            "h",   "txt",  "",    "",    "",    ""],
  ["csv",         "CSV / Data",   "csv tsv",                        "h",   "txt",  "",    "",    "",    ""],
  ["key",         "Key file",     "key crt pem pub",                "h",   "txt",  "",    "",    "",    ""],
  ["tex2",        "TeX",          "",                               "pct", "txt",  "tex", "",    "",    ""],
  ["asm2",        "ASM",          "",                               "pct", "asm",  "asm", "asm", "",    ""],
  ["swiftui",     "SwiftUI",      "",                               "c",   "swift","swift","",   "swift",""],
  ["plain",       "Plain Text",   "txt text log me",                "plain","txt","",  "",    "",    ""],
];

// ---------------------------------------------------------------------------
//  LANG — the engine every other phase reads from
// ---------------------------------------------------------------------------
const LANG = (()=>{
  const byId = new Map(), byExt = new Map();

  function build(row){
    const [id,name,exts,fam,sym,kw,bi,ty,run] = row;
    const f = FAM[fam] || FAM.plain;
    const spec = {
      id, name,
      exts: String(exts||"").split(/\s+/).filter(Boolean),
      fam,
      line:f.line||[], block:f.block||[], str:f.str||[], esc:!!f.esc, raw:f.raw||null,
      pairs: f.pairs||{}, indent: f.ind||2,
      xml: !!f.xml, markdown: !!f.markdown, regexp: !!f.regexp,
      openers: OPENERS.filter(o=> o==='"'||o==="'" ? f.str.length : !!f.pairs[o]),
      kw:   K(KW[kw]||""),
      bi:   K(BUILTINS[bi]||""),
      ty:   K(TYPES[ty]||""),
      con:  K(CONSTS[kw]||""),
      sym:  (SYM[sym]||[]).reduce((acc,r)=>{
        try{ const [kind,src,g]=r; acc.push({kind, re:new RegExp(src,"gm"), g:g||1}); }
        catch(e){ console.warn("[cyrus-studio] bad symbol rule for "+id+": "+e.message); }
        return acc;
      }, []),
      run,
    };
    byId.set(id,spec);
    spec.exts.forEach(e=>{ if(!byExt.has(e)) byExt.set(e,spec); });
    return spec;
  }
  LANGS.forEach(build);
  // names/aliases that map onto existing specs
  [["node","javascript"],["ts","typescript"],["py","python"],["jsx","javascript"],
   ["sh","bash"],["shell","bash"],["zsh","bash"],["yml","yaml"],["rs","rust"],
   ["golang","go"],["rb","ruby"],["kt","kotlin"],["cs","csharp"],["c#","csharp"],
   ["c++","cpp"],["h","c"],["hpp","cpp"],["pl","perl"],["lua51","lua"],
   ["objective-c","objectivec"],["asm","asm"],["batchfile","batch"],
   ["tf","hcl"],["hcl","hcl"],["proto3","proto"],["docker","dockerfile"]
  ].forEach(([alias,id])=>{ if(byId.has(id)){ const s=byId.get(id); if(!s.exts.includes(alias)){ s.exts.push(alias); byExt.set(alias,s); } } });
  // Terraform — worth its own row so hcl gets real syntax
  build(["hcl","Terraform / HCL","tf hcl tfvars nomad vault","h","txt","sh","sh","",  "terraform"]);
  build(["jsonc","JSON with comments","jsonc jsonl ndjson geojson","c","json","","","","json"]);

  function byName(n){ return byId.get(String(n||"").toLowerCase()) || null; }

  function forPath(path, content){
    const base = String(path||"").split("/").pop()||"";
    const lname = base.toLowerCase();
    // exact filename wins (Dockerfile, Makefile, CMakeLists.txt)
    const exact = {"dockerfile":1,"makefile":1,"cmakelists.txt":1,"rakefile":1,"gemfile":1,"procfile":1,"vagrantfile":1,
      "requirements.txt":1,"cargo.toml":1,"go.mod":1,"package.json":1,"pyproject.toml":1,"build.gradle":1,
      ".gitignore":1,".env":1,"license":1,"readme":1,"todo":1,"hosts":1,"passwd":1,"fstab":1};
    if(exact[lname]){
      if(/^dockerfile/.test(lname)) return byId.get("dockerfile");
      if(/^makefile/.test(lname)) return byId.get("make");
      if(lname==="cmakelists.txt") return byId.get("cmake");
      if(lname==="rakefile"||lname==="gemfile") return byId.get("ruby");
      if(/^requirements|^pyproject/.test(lname)) return byId.get("toml");
      if(/^cargo\.toml/.test(lname)) return byId.get("toml");
      if(/^go\.mod/.test(lname)) return byId.get("toml");
      if(/^package\.json$/.test(lname)) return byId.get("json");
      if(/^build\.gradle/.test(lname)) return byId.get("jvm");
      if(lname.startsWith(".")) return derive(lname);
    }
    const dot = lname.lastIndexOf(".");
    if(dot>0){
      const ext = lname.slice(dot+1);
      const hit = byExt.get(ext);
      if(hit) return hit;
      return derive(ext, content);
    }
    // shebang detection
    if(content){
      const m = String(content).slice(0,120).match(/^#!\s*(\S+)(?:\s+(\S+))?/);
      if(m){
        const sh=[/bash/,/sh$/,/zsh/,/ksh/,/python/,/node/,/ruby/,/perl/,/php/,/lua/,/rscript/,/julia/,/R/,/awk/,/sed/];
        for(const r of sh) if(r.test(m[1])){ const n=r.source.replace(/[\\^$]/g,""); }
        const map={bash:"bash",sh:"bash",zsh:"bash",ksh:"bash",python:"python",python3:"python",node:"javascript",
                   ruby:"ruby",perl:"perl",php:"php",lua:"lua",rscript:"r",julia:"julia",R:"r",awk:"sh",env:"sh"};
        const key=map[m[1].split("/").pop()]|| (m[2]&&map[m[2].split("/").pop()]);
        if(key&&byId.has(key)) return byId.get(key);
      }
    }
    return byId.get("plain");
  }

  // Unknown extension → derive a workable spec from the extension itself so a
  // brand-new language still highlights and still gets diagnostics.
  const derived = new Map();
  function derive(ext, content){
    ext = String(ext||"").toLowerCase();
    if(derived.has(ext)) return derived.get(ext);
    let fam = "plain";
    if(content){
      const s = String(content).slice(0,4000);
      if(/\n\s*(def |class )|\n\s*import \w|\nfrom \w+ import/.test(s)) fam="h";
      else if(/\/\*[\s\S]*?\*\/|\n\s*(function|class|const|let) /.test(s)) fam="c";
      else if(/\n#|\n--|\bSECTION\b/.test(s)) fam="h";
    }
    const spec = {
      id:"~"+ext, name: ext.toUpperCase()+" (derived)", exts:[ext], fam,
      line:FAM[fam].line||[], block:FAM[fam].block||[], str:FAM[fam].str||[], esc:!!FAM[fam].esc, raw:null,
      pairs: FAM[fam].pairs||{}, indent:FAM[fam].ind||2, xml:false, markdown:false, regexp:false,
      openers: OPENERS.filter(o=> o==='"'||o==="'" ? FAM[fam].str.length : !!FAM[fam].pairs[o]),
      kw:new Set(), bi:new Set(), ty:new Set(), con:new Set(), sym:[], run:"", derived:true,
    };
    derived.set(ext,spec);
    return spec;
  }

  // ---- tokenizer ---------------------------------------------------------
  // Emits [{s,e,t}]. Single pass. Used by the highlighter, the diagnostics
  // engine and the AI context builder.
  function tokenize(src, spec){
    const out = []; const n = src.length; let i = 0;
    const kw = spec.kw, bi = spec.bi, ty = spec.ty, con = spec.con;
    const push = (s,e,t)=>{ if(e>s) out.push({s:s,e:e,t:t}); };
    let prev = "";                 // last significant token text
    let prevType = "";
    const isWordStart = c => /[A-Za-z_$]/.test(c);
    const isWord = c => /[A-Za-z0-9_$]/.test(c);
    const OPS = ["===","!==","...","**=","<<=",">>=","&&=","||=","??=",">>>","=>","->","::","++","--","+=","-=","*=","/=","%=","&&","||","??","?.","==","!=","<=",">=","<<",">>","**","+","-","*","/","%","=","<",">","!","&","|","^","~","?","@","#","$"];

    while(i<n){
      const c = src[i];

      // whitespace — skip, renderer fills the gaps as plain text
      if(c===" "||c==="\t"||c==="\n"||c==="\r"){ i++; continue; }

      // ---- markup
      if(spec.xml && c==="<"){
        const m = /^<\?([\s\S]*?)\?>/.exec(src.slice(i));
        if(m){ push(i,i+m[0].length,"dec"); i+=m[0].length; continue; }
        const cm = /^<!--[\s\S]*?(?:-->|$)/.exec(src.slice(i));
        if(cm){ push(i,i+cm[0].length,"cmt"); i+=cm[0].length; prev=""; continue; }
        const cl = /^<!\[CDATA\[[\s\S]*?\]\]>/.exec(src.slice(i));
        if(cl){ push(i,i+cl[0].length,"str"); i+=cl[0].length; continue; }
        const dt = /^<![A-Za-z]+/.exec(src.slice(i));
        if(dt){ const gt=src.indexOf(">",i); push(i, gt<0?n:gt+1, "tag"); i=(gt<0?n:gt+1); continue; }
        const tg = /^<\/?[A-Za-z][\w:.-]*/.exec(src.slice(i));
        if(tg){
          push(i, i+tg[0].length, "tag"); i+=tg[0].length;
          // attributes until '>' or '/>'
          while(i<n && src[i]!==">"){
            if(src[i]===" "||src[i]==="\t"||src[i]==="\n"){ i++; continue; }
            if(spec.esc && src[i]==="\\"){ push(i,i+2,"esc"); i+=2; continue; }
            if(src[i]==='"'||src[i]==="'"){ const s0=i, q=src[i]; i++;
              while(i<n && src[i]!==q){ if(src[i]==="\n")break; i++; }
              if(src[i]===q) i++;
              push(s0,i,"str"); continue; }
            if(src[i]==="/"||src[i]==="="){ push(i,i+1,"op"); i++; continue; }
            const at = /^[A-Za-z_:@#][\w:.@-]*/.exec(src.slice(i));
            if(at){ push(i,i+at[0].length,"attr"); i+=at[0].length; continue; }
            i++;
          }
          if(i<n){ push(i,i+1,"tag"); i++; }
          prev=">"; prevType="tag";
          continue;
        }
      }

      // ---- markdown
      if(spec.markdown){
        const rest = src.slice(i);
        const h = /^#{1,6}[^\n]*/.exec(rest);
        if(h){ push(i,i+h[0].length,"kw"); i+=h[0].length; continue; }
        const b = /^(?:```|~~~)[^\n]*\n?/.exec(rest);
        if(b){ push(i,i+b[0].length,"str"); i+=b[0].length; continue; }
        const bl = /^(?:[-*+]|\d+\.)\s/.exec(rest);
        if(bl){ push(i,i+bl[0].length,"kw"); i+=bl[0].length; continue; }
        const lk = /^\[[^\]\n]*\]\([^)\n]*\)/.exec(rest);
        if(lk){ push(i,i+lk[0].length,"fn"); i+=lk[0].length; continue; }
        const bt = /^`[^`\n]*`/.exec(rest);
        if(bt){ push(i,i+bt[0].length,"str"); i+=bt[0].length; continue; }
      }

      // ---- block comment
      let matched = false;
      for(const b of (spec.block||[])){
        if(src.startsWith(b[0],i)){
          const e = src.indexOf(b[1], i+b[0].length);
          const end = e<0 ? n : e+b[1].length;
          push(i,end,"cmt"); i=end; matched=true; break;
        }
      }
      if(matched){ prev=""; continue; }

      // ---- line comment
      for(const l of (spec.line||[])){
        if(src.startsWith(l,i)){
          let e=i; while(e<n && src[e]!=="\n") e++;
          push(i,e,"cmt"); i=e; prev=""; matched=true; break;
        }
      }
      if(matched) continue;

      // ---- string
      for(const s of (spec.str||[])){
        if(src.startsWith(s[0],i)){
          const raw = spec.raw && spec.raw.indexOf(s[0])>=0;
          let j = i+s[0].length;
          while(j<n){
            if(!raw && spec.esc && src[j]==="\\"){ j+=2; continue; }
            if(src.startsWith(s[1],j)){ j+=s[1].length; break; }
            if(s[1].length===1 && src[j]==="\n") break;     // unterminated single-line
            j++;
          }
          push(i,j,"str"); i=j; prev="str"; prevType="str"; matched=true; break;
        }
      }
      if(matched) continue;

      // ---- number
      if(/[0-9]/.test(c) || (c==="." && /[0-9]/.test(src[i+1]||""))){
        const m = /^(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)(?:[eE][+-]?\d+)?[a-zA-Z_]*n?|[0-9][a-zA-Z_]*/.exec(src.slice(i));
        if(m){ push(i,i+m[0].length,"num"); i+=m[0].length; prev=m[0]; prevType="num"; continue; }
      }

      // ---- regexp literal (c-family heuristic)
      if(spec.regexp && c==="/" && (prevType==="op"||prevType==="kw"||prevType==="pun"||prev==="("||prev===","||prev===""||prev==="["||prev==="return"||prev===";")){
        let j=i+1, ok=false, inClass=false;
        while(j<n && src[j]!=="\n"){
          if(src[j]==="\\"){ j+=2; continue; }
          if(src[j]==="[") inClass=true;
          else if(src[j]==="]") inClass=false;
          else if(src[j]==="/" && !inClass){ ok=true; j++; break; }
          j++;
        }
        if(ok){ let k=j; while(k<n && /[a-z]/.test(src[k])) k++;
          push(i,k,"regexp"); i=k; prev=""; prevType="regexp"; continue; }
      }

      // ---- word
      if(isWordStart(c)){
        let j=i; while(j<n && isWord(src[j])) j++;
        const w = src.slice(i,j);
        let t = "";
        if(kw.has(w)) t="kw";
        else if(con.has(w)) t="num";
        else if(bi.has(w)) t="bi";
        else if(ty.has(w)) t="ty";
        else {
          let k=j; while(k<n && (src[k]===" "||src[k]==="\t")) k++;
          if(src[k]==="(") t="fn";
          else if(spec.pairs["{"] && src[j]==="{" && /^\s*\{/.test(src.slice(j))) t="cls";
          else if(/^[A-Z][A-Z0-9_]{1,}$/.test(w)) t="var";
          else if(/^[A-Z]/.test(w)) t="cls";
          else if(/^[@$][A-Za-z_]/.test(w)) t="ty";
        }
        push(i,j,t||""); i=j; prev=w; prevType=t||"word";
        continue;
      }

      // ---- operator / punctuation
      const op = OPS.find(o=>src.startsWith(o,i));
      if(op){ push(i,i+op.length,"op"); i+=op.length; prev=op; prevType="op"; continue; }
      push(i,i+1,"pun"); i++; prev=c; prevType="pun";
    }
    return out;
  }

  return { byId, byExt, LANGS, forPath, byName, derive, tokenize,
           count: byId.size, extCount: byExt.size };
})();// ---------------------------------------------------------------------------
//  Symbols — structure, not just colour.
// ---------------------------------------------------------------------------
const SYMBOLS = (()=>{
  function lineStarts(src){
    const starts=[0];
    for(let i=0;i<src.length;i++) if(src[i]==="\n") starts.push(i+1);
    return starts;
  }
  function lineOf(starts,pos){
    let lo=0, hi=starts.length-1;
    while(lo<hi){ const mid=(lo+hi+1)>>1; if(starts[mid]<=pos) lo=mid; else hi=mid-1; }
    return lo;
  }

  function extract(src, spec){
    const starts = lineStarts(src);
    const out = [];
    const seen = new Set();
    for(const rule of (spec.sym||[])){
      rule.re.lastIndex = 0;
      let m, guard = 0;
      while((m = rule.re.exec(src)) && guard++ < 2000){
        const name = (m[rule.g]||"").trim();
        if(!name || name.length>80) continue;
        let pos = m.index + m[0].indexOf(name);
        if(pos<0) continue;
        const line = lineOf(starts,pos);
        const col = pos - starts[line];
        const key = rule.kind+":"+name+":"+line;
        if(seen.has(key)) continue;
        seen.add(key);
        // nesting: count indentation depth for the outline
        let depth = 0;
        for(let i=line-1;i>=0;i--){
          const ls = src.slice(starts[i], i+1<starts.length?starts[i+1]-1:src.length);
          const t = ls.trim();
          if(!t) continue;
          const ind = ls.length - ls.replace(/^[ \t]*/,"").length;
          if(ind < col - 1){ depth++; if(depth>8) break; }
          else break;
        }
        out.push({ name, kind:rule.kind, line, col, pos, depth,
                   container: nearestContainer(out, line, col) });
      }
    }
    out.sort((a,b)=> a.line-b.line || a.col-b.col);
    return out.slice(0,900);
  }
  function nearestContainer(list, line, col){
    let best=null;
    for(const s of list){
      if(s.line<=line && (s.line<line || s.col<=col)){
        if(!best || s.line>best.line || (s.line===best.line && s.col>best.col)) best=s;
      }
    }
    return best ? best.name : null;
  }

  // enclosing symbol at a caret position
  function at(list, line, col){
    let best=null;
    for(const s of list){
      if(s.line<=line){
        if(s.kind==="fn"||s.kind==="cls"||s.kind==="int"||s.kind==="let"){
          const end = list.find(x=>x!==s && x.line>s.line && x.depth<=s.depth);
          const eLine = end ? end.line : Infinity;
          if(line < eLine || (line===eLine && (end? col<=end.col : true))){
            if(!best || s.line>=best.line) best=s;
          }
        }
      }
    }
    return best;
  }

  // workspace-wide reference search for an identifier
  function references(src, name, spec){
    const out=[]; const starts=lineStarts(src);
    const re = new RegExp("\\b"+name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\b","g");
    let m, guard=0;
    while((m=re.exec(src)) && guard++<400){
      out.push({ line: lineOf(starts,m.index), col: m.index-starts[lineOf(starts,m.index)], pos:m.index, len:name.length });
    }
    return out;
  }

  return { extract, at, references, lineStarts, lineOf };
})();

// ---------------------------------------------------------------------------
//  Diagnostics — compiler-free structural analysis, honest about its limits.
// ---------------------------------------------------------------------------
const DIAG = (()=>{
  const SEV = { err:3, warn:2, info:1 };
  // column of the `var` keyword itself, not the char in front of it
  const varIdx = L => { const m=/(^|[^\w.])var\s+[A-Za-z_$]/.exec(L); return m ? m.index+m[1].length : 0; };
  function analyze(src, spec, opts={}){
    const out = [];
    const starts = SYMBOLS.lineStarts(src);
    const lineOf = p => SYMBOLS.lineOf(starts,p);
    // `pos` is the character offset. Fixers need it to build a range edit without
    // re-parsing the source, so every diagnostic carries one from the start.
    const at = p => { const l=lineOf(p); return { pos:p, line:l, col:p-starts[l] }; };
    const atLC = (l,c) => { const p=(starts[l]||0)+c; return { pos:p, line:l, col:c }; };

    // ---- 1. bracket balance, computed from the token stream (so strings and
    //         comments never produce phantom errors)
    const toks = LANG.tokenize(src, spec);
    const stack = [];
    // Angle brackets are deliberately excluded: in every C-family language `<`
    // and `>` are overwhelmingly comparison operators, so pairing them turns
    // `if(x > 1)` into three bogus diagnostics. The highlighter can afford the
    // guess because it only colours text; the balance check cannot.
    const PAIRS = spec.pairs || {};
    const openers = Object.keys(PAIRS).filter(o=>o!=="<" && o!==">");
    const closers = openers.map(o=>PAIRS[o]);
    // Once a mismatch happens the stack no longer describes the file, so
    // anything derived from it afterwards would be a confident lie. `const b =
    // [1,2;` makes the `}` swallow the `[` and the remaining `{` then looks
    // unclosed — appending a `}` would "fix" a file that was missing a `]`.
    let desynced = false;
    for(const t of toks){
      if(t.t!=="op" && t.t!=="pun") continue;
      const ch = src[t.s];
      if(openers.includes(ch)) stack.push({ch, pos:t.s});
      else if(closers.includes(ch)){
        const want = openers.find(o=>PAIRS[o]===ch);
        const top = stack.pop();
        if(!top){ desynced = true;
          out.push({...at(t.s), len:1, sev:"err", msg:`Unexpected closing “${ch}”`, src:"bracket" }); }
        else if(top.ch!==want){
          desynced = true;
          const p=at(top.pos);
          out.push({...p, len:1, sev:"err", msg:`“${top.ch}” closed by “${ch}”`, src:"bracket" });
          const q=at(t.s);
          out.push({...q, len:1, sev:"warn", msg:`Expected “${PAIRS[top.ch]}” to close this`, src:"bracket" });
        }
      }
    }
    // `order` is the opener's depth in the stack, so closing several at once can
    // emit them innermost-first and reconstruct the nesting correctly
    if(!desynced) stack.slice(0,8).forEach((s,i)=>{
      out.push({...at(s.pos), order:i, len:1, sev:"err", msg:`“${s.ch}” is never closed`, src:"bracket" });
    });

    // ---- 2. unterminated strings (tokenizer stops at newline)
    for(const t of toks){
      if(t.t!=="str") continue;
      const text = src.slice(t.s,t.e);
      const open = spec.str.find(s=>text.startsWith(s[0]));
      if(!open) continue;
      const closed = text.length>=open[0].length+open[1].length && text.endsWith(open[1]) && text.slice(-open[1].length-1, -open[1].length)!==undefined
                     && text.trimEnd().endsWith(open[1]);
      if(!closed){
        out.push({...at(t.s), len:Math.min(text.length,60), sev:"err", msg:"String is never closed", src:"string" });
      }
    }

    // ---- 3. line-level rules
    const lines = src.split("\n");
    const MAXL = opts.maxLine || 140;
    for(let i=0;i<lines.length;i++){
      const L = lines[i];
      if(L.length>MAXL) out.push({...atLC(i,MAXL),len:1,sev:"info",msg:`Line is ${L.length} characters`,src:"style"});
      if(/\t/.test(L) && /^ +\S/.test(L.replace(/^\t+/,"")) && spec.indent===4 && /^\t|^\s{2,4}\t/.test(L)){
        out.push({...atLC(i,0),len:1,sev:"warn",msg:"Mixed tabs and spaces in indentation",src:"style"});
      }
      if(spec.regexp){
        const m=/[^=!<>]==[^=]/.exec(L); if(m && !/["'`]/.test(L.slice(Math.max(0,m.index-1),m.index)))
          out.push({...atLC(i,m.index+1),len:2,sev:"warn",msg:"Loose equality — consider ===",src:"quality"});
        if(/(^|[^\w.])var\s+[A-Za-z_$]/.test(L) && !/\/\//.test(L.split(m&&m.index)[0]||""))
          out.push({...atLC(i,varIdx(L)),len:3,sev:"info",msg:"`var` is function-scoped — prefer let/const",src:"quality"});
        if(/\bdebugger\b/.test(L)) out.push({...atLC(i,L.indexOf("debugger")),len:8,sev:"warn",msg:"`debugger` statement left in",src:"quality"});
      }
      if(/\b(TODO|FIXME|HACK|XXX)\b/.test(L))
        out.push({...atLC(i,Math.max(0,L.search(/\b(TODO|FIXME|HACK|XXX)\b/)||L.length-4)),len:4,sev:"info",msg:"Note: "+L.match(/\b(TODO|FIXME|HACK|XXX)\b/)[0],src:"note"});
      if(spec.id==="python" && /^\s*except\s*:/.test(L))
        out.push({...atLC(i,L.indexOf("except")),len:6,sev:"warn",msg:"Bare except swallows every error",src:"quality"});
      if(spec.id==="cpp" && /^\s*#\s*include\s*<[^>]*\.h>/.test(L))
        out.push({...atLC(i,0),len:1,sev:"info",msg:"C header in C++ — prefer the matching .hpp",src:"style"});
      if(/\b(password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*["'][^"']{6,}["']/i.test(L))
        out.push({...atLC(i,Math.max(0,L.search(/\b(password|passwd|secret|api[_-]?key|token)\b/i))),len:4,sev:"warn",msg:"Possible hard-coded secret",src:"security"});
    }

    // ---- 4. unused imports (high signal, low false-positive)
    const imported = [];
    // Branch on language identity, never on a loose flag. `spec.fam` is "c" for
    // almost everything curly-braced (including JavaScript) and `spec.regexp`
    // is true for most of them too, so either test misroutes #include and
    // import rules. Only these languages actually spell it #include.
    const C_INCLUDE = new Set(["c","cpp","objectivec"]);
    if(spec.id==="python"){
      const re=/^[ \t]*(?:from[ \t]+([.\w]+)[ \t]+import[ \t]+(.+)|import[ \t]+([.\w, ]+))$/gm;
      let m;
      while((m=re.exec(src))){
        const names=(m[2]||m[3]||"").split(",").map(s=>s.trim().split(/\s+as\s+/).pop()).filter(Boolean);
        names.forEach(n=> imported.push({name:n.replace(/^\./,""), pos:m.index}));
      }
    } else if(C_INCLUDE.has(spec.id)){
      const re=/^[ \t]*#\s*include\s*[<"]([^>"]+)[>"]/gm;
      let m;
      while((m=re.exec(src))) imported.push({name:null, pos:m.index, header:m[1]});
    } else if(spec.regexp || spec.id==="typescript" || spec.id==="javascript"){
      const re=/^[ \t]*import[ \t]+(?:([A-Za-z_$][\w$]*)[ \t]*,?\s*)?(?:.*?from\s*)?["'][^"']+["']/gm;
      let m;
      while((m=re.exec(src))) if(m[1]) imported.push({name:m[1], pos:m.index});
      const re2=/^[ \t]*const[ \t]*\{([^}]*)\}[ \t]*=[ \t]*require\(/gm;
      while((m=re2.exec(src))) m[1].split(",").forEach(n=>{ const nm=n.trim().split(":").pop().trim(); if(nm) imported.push({name:nm,pos:m.index}); });
    } else if(spec.fam==="c"){
      const re=/^[ \t]*#\s*include[ \t]*[<"]([^>"]+)[>"]/gm;
      let m;
      while((m=re.exec(src))) imported.push({name:null, pos:m.index, header:m[1]});
    }
    const bodyNoImports = src.replace(/^[ \t]*(?:import|from|#\s*include|use)[^\n]*$/gm,"");
    for(const im of imported){
      if(im.name){
        const uses = (bodyNoImports.match(new RegExp("\\b"+im.name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\b","g"))||[]).length;
        if(uses===0) out.push({...at(im.pos), len:im.name.length, sev:"info", msg:`“${im.name}” is imported but never used`, src:"unused"});
      } else if(im.header){
        const guard = new RegExp("#\\s*ifndef\\s+_?"+im.header.replace(/[^\w]/g,"").toUpperCase());
        if(!guard.test(src)) out.push({...at(im.pos), len:im.header.length+9, sev:"warn", msg:`“${im.header}” has no include guard`, src:"quality"});
      }
    }

    // ---- 5. defined-but-never-referenced functions (info only)
    const syms = SYMBOLS.extract(src, spec);
    for(const s of syms){
      if(s.kind!=="fn") continue;
      if(/^(test_|Test|setUp|tearDown|main|__)/.test(s.name)) continue;
      const line = src.slice(starts[s.line], starts[s.line+1]||src.length);
      const uses = (src.match(new RegExp("\\b"+s.name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\b","g"))||[]).length;
      if(uses<=1 && line.length<400) out.push({...atLC(s.line,s.col), len:s.name.length, sev:"info", name:s.name, msg:`“${s.name}” is defined but never referenced`, src:"unused"});
    }

    out.sort((a,b)=> a.line-b.line || a.col-b.col || SEV[b.sev]-SEV[a.sev]);
    return out.slice(0,200);
  }

  const runnerPatterns = [
    { re:/^([\w./\\-]*?)(\w+)\.(\w+):(\d+):?\s*(.*)$/, sev:"err", msg:m=>`${m[2]}.${m[3]} — ${m[5]||m[4]}`, file:m=>m[1]?m[1]+"."+m[2]:"", line:m=>+m[4] },
    { re:/^Traceback \(most recent call last\)/, sev:"err", msg:()=>"Python traceback", file:()=>null, line:()=>0, bare:true },
    { re:/^\s*File "([^"]+)", line (\d+)/, sev:"err", msg:m=>"Python traceback", file:m=>m[1], line:m=>+m[2] },
    { re:/^([\w./\\-]+):(\d+):(\d+):?\s*(?:fatal\s+)?(?:error|Error)(.*)$/, sev:"err", msg:m=>"Compiler error", file:m=>m[1], line:m=>+m[2] },
    { re:/^(?:.*?\b)?(Warning|warning|warn)\b:?\s*(.*)$/, sev:"warn", msg:m=>m[1]+": "+m[2], file:()=>null, line:()=>0 },
    { re:/^(.*?):(\d+):(\d+):?\s*note:/, sev:"info", msg:m=>"Note: "+m[1], file:m=>m[1], line:m=>+m[2] },
    { re:/^\s*(?:ERROR|Error|error):\s*(.*)$/, sev:"err", msg:m=>m[1], file:()=>null, line:()=>0 },
    { re:/^\s*(WARN|Warning|warning):\s*(.*)$/, sev:"warn", msg:m=>m[1], file:()=>null, line:()=>0 },
  ];

  // turn raw runner output into clickable problems
  function fromOutput(text, fileHint){
    const out=[];
    const src = String(text);
    // a bare "Traceback ..." header is only interesting when no frame line follows it
    const hasFrames = /^\s*File\s+"[^"]+",\s*line\s+\d+/m.test(src);
    for(const line of src.split("\n").slice(0,400)){
      for(const p of runnerPatterns){
        if(p.bare && hasFrames) continue;
        const m = p.re.exec(line);
        if(m){
          const f = p.file(m);
          out.push({ file: f && !/^<|^\//.test(f) ? f : (fileHint||null), line: p.line(m)||0, col:0, len:1,
                     sev:p.sev, msg:p.msg(m), src:"run", raw:line });
          break;
        }
      }
    }
    return out;
  }

  const counts = list => list.reduce((a,d)=>{ a[d.sev]=(a[d.sev]||0)+1; return a; }, {});
  // ---------------------------------------------------------------------------
  //  QUICK FIX
  //  Two tiers, and the difference matters more than anything else in here:
  //
  //    mechanical — CYRUS already proved the bug from the token stream, so it
  //                 computes the patch itself. No model is consulted and the
  //                 fix is correct for the class of error it claims.
  //    ai         — a guess. Offered because a human still reviews the diff,
  //                 never because CYRUS knows the answer.
  //
  //  A fix is a list of range edits {start, end, insert} rather than a
  //  replacement string, so it can be previewed, applied out of order and
  //  combined with other fixes without any of them invalidating the others.
  // ---------------------------------------------------------------------------
  // `safe` means "batching this changes nothing the author meant to write".
  // Safe fixes are what "Fix all" is allowed to apply together. Adding a
  // keyword like `export` is mechanical and correct but it changes the module's
  // public surface, so it stays a one-at-a-time decision.
  const M = (id, label, edits, note, order, safe) =>
    ({ id, label, kind:"mechanical", edits, note:note||"", order:order||0, safe:safe!==false });
  const A = (id, label) => ({ id, label, kind:"ai", edits:null, note:"" });
  const lineEndOf = (src, pos) => { const n=src.indexOf("\n", pos); return n<0 ? src.length : n; };
  const eof = src => src.replace(/[ \t]*\n?$/,"").length;

  function quickFix(src, spec, d){
    if(!d) return [];
    const fixes = [];
    const at1 = d.pos==null ? 0 : d.pos;

    // ---- brackets ------------------------------------------------------
    let m;
    if(d.src==="bracket" && (m=/^“(.+?)” is never closed$/.exec(d.msg))){
      const closer = (spec.pairs||{})[m[1]];
      if(closer) fixes.push(M("bracket.close", `Insert the missing “${closer}”`, [{start:eof(src), end:eof(src), insert:closer}], "", d.order));
    }
    if(d.src==="bracket" && (m=/^Expected “(.+?)” to close this$/.exec(d.msg))){
      // Deliberately no mechanical fix here. A mismatched pair means the parser
      // lost sync, and the right place for the missing closer is genuinely
      // ambiguous: `if(x > 1 {` would come back as `if(x >) 1 {`. That is a
      // guess wearing the costume of a certainty, so it goes to the model.
    }
    if(d.src==="bracket" && (m=/^Unexpected closing “(.+?)”$/.exec(d.msg))){
      const opener = Object.keys(spec.pairs||{}).find(o=>spec.pairs[o]===m[1]);
      if(opener) fixes.push(M("bracket.open", `Insert the missing opening “${opener}”`, [{start:at1, end:at1, insert:opener}]));
    }

    // ---- strings --------------------------------------------------------
    if(d.src==="string"){
      const quote = /^[“'"]/.test(d.msg) ? null : src[at1];
      if(quote) fixes.push(M("string.close", `Close the string with “${quote}”`,
        [{start:lineEndOf(src,at1), end:lineEndOf(src,at1), insert:quote}]));
    }

    // ---- unused imports --------------------------------------------------
    if(d.src==="unused" && (m=/^“(.+?)” is imported but never used$/.exec(d.msg))){
      const ls = src.lastIndexOf("\n", at1-1)+1;          // statement start
      let le = src.indexOf("\n", ls); if(le<0) le = src.length;
      const stmt = src.slice(ls, le);
      // only delete when the statement really does nothing but import this one
      const single = spec.id==="python"
        ? new RegExp("^\\s*(?:import|from)\\s+.*\\b"+m[1]+"\\b.*$").test(stmt)
        : /^\s*(?:import\s+[\w$]+\b|const\s*\{)/.test(stmt);
      if(single) fixes.push(M("unused.import", `Remove the unused import of “${m[1]}”`,
        [{start:ls, end:le, insert:""}], "deletes one line"));
    }
    if(d.src==="unused" && (m=/^“(.+?)” is defined but never referenced$/.exec(d.msg))){
      const ls = src.lastIndexOf("\n", at1-1)+1;
      if((spec.regexp || spec.id==="typescript") && /^\s*(function|const|let|class)\b/.test(src.slice(ls,ls+40)) && !/\bexport\b/.test(src.slice(ls,ls+20))){
        fixes.push(M("unused.export", `Export “${m[1]}” so it is referenced`, [{start:ls, end:ls, insert:"export "}], "", 0, false));
      }
    }

    // ---- quality --------------------------------------------------------
    if(d.src==="quality" && d.msg.indexOf("Loose equality")===0){
      const op = src.substr(at1,2);
      const strict = op==="!=" ? "!==" : "===";
      fixes.push(M("eq.strict", `Use “${strict}”`, [{start:at1, end:at1+2, insert:strict}]));
    }
    if(d.src==="quality" && d.msg.indexOf("`var`")===0)
      fixes.push(M("var.let", "Use “let” instead of “var”", [{start:at1, end:at1+3, insert:"let"}]));
    if(d.src==="quality" && d.msg.indexOf("Bare except")===0)
      fixes.push(M("except.ex", "Catch “Exception” explicitly",
        [{start:at1+6, end:at1+6, insert:" Exception"}]));
    if(d.src==="quality" && (m=/^“(.+?)” has no include guard$/.exec(d.msg))){
      const guard = m[1].replace(/[^\w]/g,"").toUpperCase();
      fixes.push(M("guard.add", `Wrap in include guard “${guard}”`, [
        {start:0, end:0, insert:`#ifndef ${guard}\n#define ${guard}\n`},
        {start:eof(src), end:eof(src), insert:`\n#endif // ${guard}`}
      ]));
    }

    // ---- style ----------------------------------------------------------
    if(d.src==="style" && d.msg.indexOf("Mixed tabs and spaces")===0){
      const ls = src.lastIndexOf("\n", at1-1)+1;
      let le = src.indexOf("\n", ls); if(le<0) le = src.length;
      const body = src.slice(ls, le);
      const width = /^\t/.test(body) ? (spec.indent||2) : 2;
      const ind = /^[ \t]*/.exec(body)[0];
      const vis = ind.replace(/\t/g, " ".repeat(width));
      if(vis!==ind) fixes.push(M("style.indent", "Normalise the indentation",
        [{start:ls, end:ls+ind.length, insert:vis}], "tabs become spaces"));
    }

    // Everything else is a judgement call, so it goes to the model — and says so.
    if(!fixes.length) fixes.push(A("ai.propose", "Ask CYRUS to fix this"));
    return fixes;
  }

  // Apply many fixes at once. Edits run right-to-left so every offset stays
  // valid, and edits sharing one offset are merged into a single splice — that
  // is what lets two unclosed brackets both get their closer appended instead of
  // the second one being discarded as an overlap.
  function applyFixes(src, fixes){
    const groups = new Map();
    fixes.forEach((f,fi)=>{
      (f.edits||[]).forEach((e,ei)=>{
        const k = e.start;
        if(!groups.has(k)) groups.set(k, []);
        groups.get(k).push({ e, f, fi, ei });
      });
    });
    let out = src;
    for(const k of [...groups.keys()].sort((a,b)=> b-a)){
      const g = groups.get(k);
      // replacements that actually consume text come first; then insertions,
      // innermost opener first, so `(` then `{` closes as `)}` and not `}{`
      g.sort((a,b)=>
        (b.e.end - a.e.end) ||
        ((b.f.order||0) - (a.f.order||0)) ||
        (b.fi - a.fi));
      const ins = g.map(x=>x.e.insert).join("");
      const end = Math.max(...g.map(x=>x.e.end));
      out = out.slice(0,k) + ins + out.slice(end);
    }
    return out;
  }

  return { analyze, fromOutput, counts, SEV, quickFix, applyFixes };
})();// ---------------------------------------------------------------------------
//  HL — tokens + overlay decorations → HTML for the editor layer
//  Decorations: find matches, occurrence highlight, multi-cursor selections,
//  folded regions, diagnostics underlines, inline-AI ghost text, diff bands.
// ---------------------------------------------------------------------------
const HL = (()=>{
  const ESC = { "&":"&amp;", "<":"&lt;", ">":"&gt;" };
  const e = s => s.replace(/[&<>]/g, c=>ESC[c]);

  function render(src, spec, deco){
    const toks = LANG.tokenize(src, spec);
    deco = deco || {};
    const marks = [];

    // ---- 1. diagnostic underlines + diff bands + folded regions
    const lineStarts = SYMBOLS.lineStarts(src);
    const at = p => { let l=SYMBOLS.lineOf(lineStarts,p); return {s:lineStarts[l], e:(lineStarts[l+1]!==undefined?lineStarts[l+1]:src.length)}; };
    for(const d of (deco.problems||[])){
      const r = at(d.line!=null?lineStarts[d.line]||0 : 0);
      const off = d.line!=null && d.col!=null ? d.col : 0;
      marks.push({ s:r.s+Math.max(0,off), e:r.s+Math.max(0,off)+Math.max(1,d.len||1), c:"d-"+(d.sev==="err"?"er":d.sev==="warn"?"wr":"in"), t:"wave" });
    }
    for(const m of (deco.matches||[])) marks.push({ s:m.s, e:m.e, c:"mtch", t:"box" });
    for(const m of (deco.occurrences||[])) marks.push({ s:m.s, e:m.e, c:"occ", t:"box" });
    for(const m of (deco.sel2||[])) marks.push({ s:m.s, e:m.e, c:"sel2", t:"box" });
    for(const m of (deco.folded||[])) marks.push({ s:m.s, e:m.e, c:"fold", t:"fold" });
    for(const m of (deco.occWord||[])) marks.push({ s:m.s, e:m.e, c:"curw", t:"box" });

    // ---- 2. splice tokens + marks into one ordered stream
    const all = toks.map(t=>({s:t.s,e:t.e,c:t.t})).filter(t=>t.c);
    for(const m of marks) all.push(m);
    all.sort((a,b)=> a.s-b.s || (a.e-b.e));

    let html = "", cur = 0;
    for(const t of all){
      if(t.s < cur) continue;                     // overlapping: first wins
      if(t.s > cur) html += e(src.slice(cur,t.s));
      const body = e(src.slice(t.s,t.e));
      html += t.c
        ? '<span class="'+t.c+(t.t&&t.t!=="box"?' '+(t.t==="wave"?"wavy":t.t):"")+'">'+body+'</span>'
        : body;
      cur = t.e;
    }
    if(cur < src.length) html += e(src.slice(cur));

    // ---- 3. ghost text (inline autocomplete) appended after the caret line
    if(deco.ghost && deco.ghost.pos!=null && deco.ghost.text){
      // rebuild with the ghost split out at exactly that offset
      return render2(src, spec, deco, deco.ghost);
    }
    // trailing newline keeps the last (empty) line tall enough to click into
    if(src.endsWith("\n")) html += "\n";
    return html;
  }

  function render2(src, spec, deco, ghost){
    const html = render(src, spec, Object.assign({}, deco, {ghost:null}));
    const pos = ghost.pos;
    const gtext = ghost.text;
    const esc = s => String(s).replace(/[&<>]/g, c=>ESC[c]);
    // split the rendered html at `pos` by walking the raw source length
    let seen = 0, out = "", i = 0;
    while(i < html.length && seen < pos){
      const c = html[i];
      if(c==="&"){ const m=/^&(amp|lt|gt);/.exec(html.slice(i)); if(m){ seen += m[0]==="&amp;"?1:m[0]==="&lt;"?1:1; out+=m[0]; i+=m[0].length; continue; } }
      if(c==="<"){ const j=html.indexOf(">",i); const tag=html.slice(i,j+1); out+=tag; i=j+1; continue; }
      if(c==="\n"){ seen++; out+=c; i++; continue; }
      seen++; out+=c; i++;
    }
    const rest = html.slice(i);
    out += '<span class="ghost">'+esc(gtext)+"</span>"+rest;
    return out;
  }

  // minimap strips: one short run per token, scaled down
  function minimapRuns(src, spec, widthPx){
    const toks = LANG.tokenize(src, spec);
    const colW = 1.6;
    const runs = [];
    let prevColor = null;
    for(const t of toks){
      if(t.t!=="kw" && t.t!="str" && t.t!=="cmt" && t.t!=="num" && t.t!=="fn" && t.t!=="bi" && t.t!=="kw") continue;
      const line = src.slice(0,t.s).split("\n").length;
      const lineStart = t.s - src.lastIndexOf("\n", t.s-1) - 1;
      const col = t.s - lineStart;
      const color = { kw:"#8f5fc4", str:"#5f9e52", cmt:"#463c63", num:"#b07a45", fn:"#c9a850", bi:"#4d84c4" }[t.t];
      runs.push({ y: line*2, x: Math.floor(col*colW), w: Math.max(1, Math.round((t.e-t.s)*colW)), c:color });
      prevColor = color;
    }
    return runs;
  }

  return { render, minimapRuns };
})();