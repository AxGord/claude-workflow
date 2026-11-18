# Haxe Macro Gotchas

Part of the lang-haxe skill: full verified gotcha entries for macro authoring, indexed one-per-line in SKILL.md under "Macros — index".

## Macro `Context.error` Halts the Macro — No Defensive `continue` Needed

`haxe.macro.Context.error(msg, pos)` throws — execution does NOT fall through. The return type is `Dynamic` only because the function never returns normally. Subsequent statements in the same macro invocation are dead code.

```haxe
// Verified on Haxe 4.3.7: only "first error" is reported, "second error" is never reached.
Context.error('first error', pos);
Context.error('second error', pos);  // unreachable
```

**Implication for validation loops in build macros:** after `Context.error`, you do NOT need `continue` / `return` to skip downstream processing. Adding them is harmless but dead. One tempting anti-pattern:

```haxe
// WRONG — the `continue` is dead code; Context.error already threw
for (field in fields) {
    if (invalid(field)) {
        Context.error('bad', field.pos);
        continue; // never reached
    }
    process(field);
}

// RIGHT — trust the throw
for (field in fields) {
    if (invalid(field))
        Context.error('bad', field.pos);
    process(field);
}
```

Downside of the minimal form: the first invalid field halts the whole build, so the user sees one error per compile cycle instead of a batch. For **batched** errors across multiple fields, the right API is `Context.reportError(msg, pos)` — it records the error and continues (compilation still fails at the end), so every invalid field is reported in one compile cycle. Follow with a post-loop `Context.error` / `Context.fatalError` only if you must abort before further processing.

## Macro `FunctionArg`: `opt: true` Widens Type To `Null<T>` Even With a Default

When building a `FunctionArg` in a macro, `opt: true` corresponds to the `?` sigil in Haxe source — and `?minPrec:Int = 0` has type `Null<Int>`, not `Int`. The default value makes the parameter callable without the argument, but the `?` widens the type for strict null safety. Combining `opt: true` with `value: macro 0` produces a signature that is both "optional (via default)" AND nullable — the default is ignored for type-narrowing purposes.

Generated-code consumers that do `if (minPrec < outer)` or similar binary ops on the parameter then fail the strict null safety check with `Cannot perform binary operation on nullable value`.

**Fix**: drop `opt: true` and rely on `value` alone. A default value implicitly makes the parameter optional at call sites (matching `function f(minPrec:Int = 0)` in source) while keeping the type as non-nullable `Int`.

```haxe
// WRONG — generated param is Null<Int>, breaks binary ops under strict null
args.push({
    name: 'minPrec',
    type: macro : Int,
    opt: true,           // widens to Null<Int>
    value: macro 0,
});

// RIGHT — generated param is Int, implicitly optional via the default value
args.push({
    name: 'minPrec',
    type: macro : Int,
    value: macro 0,
});
```

## Macro Optional Expr Args: Omitted Means Null-Literal, Not Null

A macro function declared with `?options:Expr` does NOT receive `null` when the caller omits the argument at a macro-meta call site like `@:build(...)`. Haxe synthesizes an `Expr` whose `expr` field is `EConst(CIdent("null"))` — a null-literal expression — and passes that. A naive `if (options != null)` guard fires for the omitted-arg case and any validation gated on it runs spuriously.

```haxe
// WRONG — fires for callers that omit the optional arg
public static function buildWriter(typePath:Expr, ?options:Expr):Array<Field> {
    if (options != null)
        Context.error('writer takes one arg', options.pos); // hits @:build(buildWriter(T))
    ...
}

// RIGHT — normalize the Expr first, then check the result
private static function extractTypePath(e:Null<Expr>):Null<String> {
    if (e == null) return null;
    return switch e.expr {
        case EConst(CIdent('null')): null;
        case _: ExprTools.toString(e);
    };
}

public static function buildWriter(typePath:Expr, ?options:Expr):Array<Field> {
    if (extractTypePath(options) != null)
        Context.error('writer takes one arg', options.pos);
    ...
}
```

Verified on Haxe 4.3.x: a single-arg `@:build(...)` call triggered a fatal validation error meant for two-arg callers because `options.expr` was `EConst(CIdent("null"))`, not a Haxe-level `null`.

## Dangling-Else in Macro Comprehensions

When a comprehension branch contains `macro if(...)`, using `if/else` causes dangling-else: the `else` binds to the inner `macro if`, not the outer `if`. Use ternary `?:` instead.

```haxe
// WRONG — else binds to inner `macro if`, f is lost in else-branch
final exprs:Array<Expr> = [
    for (f in xmlFields)
        if (f.type == XString)
            macro if ($p{[f.field]} != null) doA($p{[f.field]})
        else
            macro if ($p{[f.field]} != null) doB($p{[f.field]})  // Unknown identifier: f
];

// RIGHT — ternary is unambiguous, both branches see f
final exprs:Array<Expr> = [
    for (f in xmlFields)
        f.type == XString
            ? macro if ($p{[f.field]} != null) doA($p{[f.field]})
            : macro if ($p{[f.field]} != null) doB($p{[f.field]})
];

// ALSO RIGHT — parentheses around `macro if` prevent dangling-else with if/else too
if (cond)
    (macro if ($p{[f.field]} != null) doA($p{[f.field]}))
else
    (macro if ($p{[f.field]} != null) doB($p{[f.field]}))
```

**General rule:** in any context where the branch body starts with `macro if(...)`, prefer `?:` over `if/else` to avoid ambiguity.

## Macro `$b{}` Creates Nested Scopes — Variables Don't Leak

`$b{exprs}` wraps the array in an `EBlock`, creating a new scope. Variables declared inside one `$b{}` are NOT visible to code in a sibling `$b{}`, even within the same function body.

```haxe
// WRONG — var declared in first $b{} is invisible in second $b{}
(macro class {
    public static function example():Void {
        $b{declarations}  // var x = null; — scoped to THIS block
        $b{usages}        // x = 42; — ERROR: Unknown identifier x
    }
}).fields.pop();

// RIGHT — build a flat Array<Expr> and embed once
final body:Array<Expr> = [];
for (e in declarations) body.push(e);
for (e in usages) body.push(e);
// ... set fun.expr = macro $b{body};
```

**Also:** `macro $i{stringVar}` may trigger identifier resolution at macro expansion time. For identifiers that only exist at runtime (e.g., load-local vars), construct the Expr manually:

```haxe
// WRONG — macro system tries to resolve _di_storage at macro time
params.push(macro $i{dep.paramName});  // Unknown identifier: _di_storage

// RIGHT — untyped AST node, resolved later during generated code typing
params.push({expr: EConst(CIdent(dep.paramName)), pos: Context.currentPos()});
```

## Single Combined `EVars` Splices Into Outer Scope (Workaround for `$b{}` Isolation)

When a macro helper must declare N vars that the caller's sibling code can read, returning `Array<Expr>` of separate `EVars` and splicing via `$b{}` doesn't help — the block still isolates. The fix: fold all `Var` entries into ONE `EVars(Array<Var>)` node and splice it as a single `$expr`.

```haxe
// WRONG — block wraps vars in new scope, caller siblings can't see them
function initVars():Expr {
    return macro { var _prev0:Int = 0; var _prev1:Int = 0; };
}
// caller: ${initVars()}; — _prev0/_prev1 NOT visible to siblings

// RIGHT — single EVars node, vars declared at caller's EBlock level
function initVars(names:Array<String>):Expr {
    final vars:Array<haxe.macro.Expr.Var> = [
        for (n in names) {name: n, type: macro:Int, expr: macro 0}
    ];
    return vars.length > 0
        ? {expr: EVars(vars), pos: Context.currentPos()}
        : (macro {});
}
// caller:
final initPrev:Expr = initVars(['_prev0', '_prev1']);
return macro { $initPrev; /* _prev0 / _prev1 VISIBLE here */ };
```

**Why it works:** a single `EVars` spliced into a parent `EBlock` IS the same form as writing `var a = 0; var b = 0;` as sibling statements — no extra nesting. `EBlock` always creates a new scope; `EVars` is just a multi-declaration statement.

**Decision rule:** N var declarations that siblings must read → fold to one `EVars(Array<Var>)`; assignments/mutations of already-declared vars → `EBlock` is fine (nested scope reads outer vars normally). Empty list → `macro {}`.

## Macro `$a{}` Is Context-Dependent: Splices Call Arguments, Builds an Array Literal Standalone

In a call-argument position, `$a{arr}` splices array elements as separate arguments, NOT as an array literal: `f($a{[x, y, z]})` becomes `f(x, y, z)` — three separate arguments. In a standalone expression position, `$a{arr}` builds an array literal: `macro $a{parts}` yields `[x, y, z]` (an `EArrayDecl`).

```haxe
// WRONG — splices as separate args: _dc(doc1, doc2, doc3)
final parts:Array<Expr> = [exprA, exprB, exprC];
macro _dc($a{parts})

// RIGHT — build the array literal first (standalone $a{} = array literal), then pass it
final arr:Expr = macro $a{parts};  // [doc1, doc2, doc3]
macro _dc($arr)  // generates: _dc([doc1, doc2, doc3])

// EQUIVALENT — construct EArrayDecl manually
final arr:Expr = {expr: EArrayDecl(parts), pos: Context.currentPos()};
macro _dc($arr)
```

When you need a macro-time `Array<Expr>` as a single runtime array argument, wrap it into an array-literal `Expr` first — inside a call's argument list, `$a{}` always splices.

## Macro `Array<Expr>` Literal — Parenthesise Each `macro …` Element

Inside an `Array<Expr>` literal (for `EBlock` / `ECall` / `EArrayDecl` construction in build macros), bare `macro …` reifications must be wrapped in parentheses. Without them, the Haxe parser treats `macro` as an identifier for the next array slot and fails with:

```
Keyword macro cannot be used as variable name
```

Plain `Expr` variables (already-built values) do NOT need parens — only `macro …` reifications.

```haxe
// WRONG — bare macro reification as array element
final block:Array<Expr> = [
    macro final _wo = _copyOpt(opt),
    macro { var _f:Bool = false; $probeBody; },
    baseRawWriteCall,
];
// Error: Keyword macro cannot be used as variable name

// RIGHT — each macro reification parenthesised
final block:Array<Expr> = [
    (macro final _wo = _copyOpt(opt)),
    (macro { var _f:Bool = false; $probeBody; }),
    baseRawWriteCall,   // plain Expr variable — no parens needed
];
```

Ternary positions like `cond ? macro X : macro Y` bind correctly without parens — the issue is specific to comma-separated array literal elements.

Verified on Haxe 4.3.7.

## Enum Constructor Calls in `macro {}` Trigger Type Checking

Direct enum constructor calls (e.g. `pkg.core.Doc.Concat(...)`) inside `macro {}` blocks trigger macro-time type checking against the real enum type. If the arguments reference runtime variables whose types can't be resolved at macro time, the compilation fails with type mismatch errors.

```haxe
// WRONG — macro-time type checking fails on runtime variable _docs
macro {
    final _docs:Array<MyEnum> = [];
    MyEnum.Concat(_docs);  // Error: type mismatch at macro expansion
}

// RIGHT — use wrapper function on the generated class
// In codegen, emit a thin wrapper:
//   private static function _dc(items:Array<MyEnum>):MyEnum return MyEnum.Concat(items);
// Then in macro:
macro {
    final _docs:Array<MyEnum> = [];
    _dc(_docs);  // just an identifier call, no macro-time type checking
}
```

Class constructor calls (`new ClassName(...)`) don't have this issue — only enum constructors. The fix is to generate wrapper functions on the target class and call those by name (plain identifiers aren't resolved at macro time).

## Enum Abstract Values in Typed Expressions Are Inlined

When reading field initializers via `f.expr()` in build macros, `enum abstract` values are already inlined to their underlying type. `Encoding.Binary` (where `Binary = 4`) appears as `TConst(TInt(4))`, NOT as `TField(_, FEnum(_, ef))`.

```haxe
// WRONG — FEnum pattern never matches for enum abstract values
private static function extractEnumIndex(texpr:TypedExpr):Int {
    return switch texpr.expr {
        case TField(_, FEnum(_, ef)): ef.index;  // never hits
        case _: -1;
    };
}

// RIGHT — enum abstract values are inlined to TConst
private static function extractInt(texpr:TypedExpr):Int {
    return switch texpr.expr {
        case TConst(TInt(v)): v;
        case TCast(inner, _): extractInt(inner);
        case TParenthesis(inner): extractInt(inner);
        case _: -1;
    };
}
```

`FEnum` only works for real `enum` types. For `enum abstract(Int)`, the compiler resolves values at typing time — the typed AST contains the raw Int, not a reference to the abstract's field.

## Macro `Context.onTypeNotFound` Does Not Fire for Internal References — Use `Context.defineModule` for Cyclic Type Synthesis

`Context.onTypeNotFound` fires only for initial top-level lookups (`Context.getType(path)` calls or user-code references to unresolved types). It does NOT fire for types referenced inside a `TypeDefinition` returned by the callback itself. Cycles therefore break: callback for A returns a TD referencing B; Haxe tries to type B, but the callback is NOT re-invoked for that internal reference, producing a fatal "Type not found".

```haxe
// WRONG — assumes callback fires recursively for types referenced inside
// a callback-returned TypeDefinition. Cycles break silently.
Context.onTypeNotFound(function(name:String):Null<TypeDefinition> {
    return switch name {
        case 'HxStatementT': makeTypeDef('HxStatementT', [{name:'body', kind:FVar(TPath({name:'HxIfStmtT',pack:[],params:[]}))}]);
        case 'HxIfStmtT':    makeTypeDef('HxIfStmtT',    [{name:'then', kind:FVar(TPath({name:'HxStatementT',pack:[],params:[]}))}]);
        case _: null;
    };
});
Context.getType('HxStatementT'); // typing the TD tries to resolve HxIfStmtT — callback NOT fired → fatal

// RIGHT — define all mutually referencing types atomically in one module
final tds:Array<TypeDefinition> = [tdHxStatementT, tdHxIfStmtT]; // A and B with cyclic refs
Context.defineModule('my.pack.Pairs', tds); // single call; cycles resolve like a multi-type .hx file
```

**Rule of thumb:**
- Single type, no cross-refs → `Context.defineType` (simpler).
- Two+ types that may reference each other → `Context.defineModule` (atomic batch).
- `Context.onTypeNotFound` — useful for lazily satisfying user-code imports, not a cycle handler.

Each TD's `pack + name` is its canonical address; the `modulePath` argument is physical location. Consumers reach sub-module types via `ModulePath.SubType`:
```haxe
import my.pack.Pairs.HxModuleT;
```

Verified on Haxe 4.3.7.

## Macro `Context.defineModule` Sub-Module Types Are Not Import-Resolvable From Other Files

Types synthesized via `Context.defineModule("pkg.Sub", [...])` are reachable from other files via fully qualified inline paths, but NOT via `import pkg.Sub.Foo`. Import resolution in other files runs before the build macro has had a chance to register the synthesized module, so `import pkg.Sub.Foo` fails with `Type not found : pkg.Sub` followed by `Type not found : Foo`. Fully qualified inline references work because Haxe re-resolves them during the typing phase, after the macro has already defined the module.

```haxe
// WRONG — sub-module import fails at parse/import phase, macro hasn't defined Pairs yet
import pkg.synth.Pairs.SynthT;  // Type not found : pkg.synth.Pairs
// ...
final ast:SynthT = MacroParser.parse(src);

// RIGHT — fully qualified inline, resolved during typing phase AFTER macro runs
final ast:pkg.synth.Pairs.SynthT = MacroParser.parse(src);
```

Real-world pattern: a build-time helper calls `Context.defineModule('pkg.synth.Pairs', paired)` where `paired` is an array of synthesized wrapper types. Consumer files that used `import pkg.synth.Pairs.SynthT` fail; switching to fully qualified inline references fixes it.

**Rule of thumb:**
- Consumer files that need macro-synthesized types: use fully qualified inline paths, NOT sub-module imports.
- Types inside a hand-written multi-type `.hx` file (Haxe's own sub-module feature): sub-module imports DO work — the module exists as source before import resolution runs. The restriction is specific to macro-synthesized modules.

Verified on Haxe 4.3.7.

## Macro `Null<T>` Appears as Both `TAbstract` and `TType` — Match Both

Haxe represents `Null<T>` two different ways in the macro `Type` enum. `@:optional` anonymous struct fields tend to arrive as `TType(Null, [inner])`; explicit `Null<T>` in enum constructor args tend to arrive as `TAbstract(Null, [inner])`. Code that only matches one form silently falls through to the default "unsupported type" branch.

```haxe
// WRONG — misses TType form; @:optional fields are never unwrapped
switch t {
    case TAbstract(ref, params):
        final a = ref.get();
        if (a.pack.length == 0 && a.name == 'Null' && params.length == 1)
            return unwrap(params[0]);
    case _:
}

// RIGHT — both representations handled
switch t {
    case TAbstract(ref, params):
        final a = ref.get();
        if (a.pack.length == 0 && a.name == 'Null' && params.length == 1)
            return unwrap(params[0]);
    case TType(ref, params):
        final d = ref.get();
        if (d.pack.length == 0 && d.name == 'Null' && params.length == 1)
            return unwrap(params[0]);
    case _:
}
```

Always handle both `TAbstract(Null, [T])` and `TType(Null, [T])` wherever `Null<T>` unwrapping is needed in macro code.

## Macro `TLazy` Thunks Hide Cross-Typedef Forward References

When a `@:build` macro fires and its marker class's fields reference typedefs defined in the same compilation unit, Haxe may deliver those field types wrapped in `TLazy(f:()->Type)`. `TLazy` matches none of the other `Type` constructors — every pattern falls through to the default branch, producing a misleading "unsupported type" fatal error.

```haxe
// WRONG — TLazy falls through to fatalError, error message gives no hint
function shape(t:Type):ShapeNode {
    switch t {
        case TAbstract(...): ...
        case TInst(...): ...
    }
    Context.fatalError('unsupported type', pos); // hits when t is TLazy
}

// RIGHT — evaluate TLazy at entry, recurse with the resolved type
function shape(t:Type):ShapeNode {
    switch t {
        case TLazy(f): return shape(f());
        case _:
    }
    switch t {
        case TAbstract(...): ...
        case TInst(...): ...
    }
    Context.fatalError('unsupported type', pos);
}
```

Add `case TLazy(f): return recurse(f())` at the top of every macro function that switches on `haxe.macro.Type`.

## Macro Null Narrowing After `throw` Does Not Propagate Into Anonymous Struct Literals

The sequential narrowing idiom `if (x == null) throw ...; x.foo()` correctly narrows `x` for method calls, assignments, and argument passing. But when `x` is referenced inside an anonymous struct literal (`{ field: x }`), the compiler infers the literal's field type from the declared type of `x` (`Null<T>`), not from the narrowed type (`T`). The literal's type becomes `{ field: Null<T> }`, which fails to unify against a target struct typed `{ field: T }`.

```haxe
// WRONG — struct literal sees Null<String>, fails to unify with target struct
var _f_name:Null<String> = null;
// ... parse loop fills _f_name ...
if (_f_name == null) throw 'missing name';
return { name: _f_name }; // Error: Cannot unify {name:Null<String>} with TargetStruct

// RIGHT — re-bind to a final with the non-null type; literal uses the narrowed local
var _f_name:Null<String> = null;
// ... parse loop fills _f_name ...
if (_f_name == null) throw 'missing name';
final _r_name:String = _f_name; // narrowing committed
return { name: _r_name }; // ok
```

Emit one `final _r_X:T = _f_X` re-bind per required struct field in macro-generated parse functions that build anonymous struct literals from nullable accumulator variables.

## Macro Dead-Code `$v{flag}` Branches Still Type-Check — `cast` Required for Reflective Calls

A `$v{flag}` compile-time bool short-circuits at **runtime**, but the compiler type-checks the whole expression **before** dead-code elimination. A reflective call like `Type.enumParameters(x)` inside a `$v{forceInlineSep}`-gated `else if` fails the build whenever the macro inlines the call across consumers whose element type is a struct, not `EnumValue`:

```
WriterLowering.hx:8365: characters 30-48 : pkg.grammar.haxe.trivia.HxMemberDeclT should be EnumValue
WriterLowering.hx:8365: characters 30-48 : ... For function argument 'e'
```

```haxe
// WRONG — type-check fails on struct-shaped element types even though
// the branch is never executed when forceInlineSep == false
} else if (_si > 0 && $v{forceInlineSep}
        && Type.enumParameters(_arr[_si - 1].node).length == 0
        && Type.enumParameters(_t.node).length == 0) {

// RIGHT — cast suppresses compile-time type-check; runtime is gated by $v{flag}
} else if (_si > 0 && $v{forceInlineSep}
        && Type.enumParameters(cast _arr[_si - 1].node).length == 0
        && Type.enumParameters(cast _t.node).length == 0) {
```

**Rule of thumb:** in macro-generated code, any reflective call (`Type.enumParameters`, `Type.getClass`, `Reflect.field`, …) inside a `$v{...}`-gated branch needs `cast` on the argument when the surrounding engine inlines the call across consumers with different static types. The flag short-circuit is a runtime gate, not a compile-time one.

Verified on Haxe 4.3.7.

## Helper Signatures Cannot Reference `Context.defineModule`-Synth Sub-Module Types

A test/consumer class trying to "force" a `@:build`-generated synth module via the `private static final _force:Class<MarkerClass> = MarkerClass;` pattern works for FQN references in METHOD BODIES, but NOT for FQN references in HELPER METHOD SIGNATURES of the same class. Method-signature typing precedes static-initializer execution, so the synth module isn't registered when the helper's parameter / return types are resolved.

```haxe
// SETUP (works in baseline): the synth module `pkg.trivia.Pairs` is
// registered by `MarkerClass`'s `@:build` macro; static-init forcing
// makes it visible to method bodies of this consumer class.
class MyTest {
    private static final _forceBuild:Class<MarkerClass> = MarkerClass;

    public function someTest():Void {
        // OK — method body, typed AFTER static-init runs
        final m:pkg.trivia.Pairs.HxModuleT = MarkerClass.parse(src);
    }

    // WRONG — parameter and return types are typed in the field
    // signature phase, BEFORE static-init. Pairs not yet registered.
    private function helper(
        fn:pkg.trivia.Pairs.HxFnDeclT
    ):Array<pkg.trivia.Pairs.HxStatementT> { ... }
    // → "Type not found : pkg.trivia.Pairs"
}
```

The error message points at the FIRST consumer-side reference inside a method body (e.g. `pkg.trivia.Pairs.HxModuleT` at line N), which is misleading — that reference would be fine on its own. The actual cause is the helper signature pulling `Pairs` resolution too early.

**Workaround:** inline the destructuring switch into each method body instead of factoring it into a helper. Top-of-file comment should record the constraint so the next reader doesn't try to factor it out again. Local typedefs / `import pkg.trivia.Pairs.HxFnDeclT` don't help — both face the same ordering issue.

This is a stricter cousin of the existing "macro-synth sub-module imports don't resolve from other files" gotcha — that one's at parse/import phase; this one's at field-signature-typing phase.

Verified on Haxe 4.3.7.
