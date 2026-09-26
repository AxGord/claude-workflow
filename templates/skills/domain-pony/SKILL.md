---
name: domain-pony
description: Pony (Haxe cross-library) gotchas
---

# Pony — Verified Gotchas

Everything below was reproduced against `pony` dev + heaps. Pony's own docs live in
`docs/` inside the library checkout (`docs/DI.md`, `docs/spritesheet.md`) — read those for
the happy path; this file is only what bites.

## DI: an `@:own` / `@:share` Initializer Runs in a STATIC Context

The builder splices those initializers into a generated static `load()`, so they cannot see
`this`, instance fields, or constructor arguments — the error names the offending identifier.
A value that only exists at runtime (an already-created application, a parsed argv, an open
connection) enters the graph through a service that FETCHES it itself:

```haxe
final class AppService {
    public final app: App;
    public function new() {
        final app: Null<App> = App.instance;
        if (app == null) throw 'Application not created';
        this.app = app;
    }
}
```

Consumers then `@:use appService` and never receive it as an argument.

## DI: `@:use` Fields Are Assigned BEFORE `super(...)` — So Views Can Be Services Too

The builder unshifts the assignments to the top of the constructor, ahead of the `super`
call. That makes a DI class over a framework base class legal, and it is what lets a UI
object pull its own parent instead of being handed one:

```haxe
final class SomeView extends XmlUi implements DI {
    @:use private var appService: AppService;
    public function new() {
        super(appService.scene);   // appService is already set here
        createUI(appService.app);
    }
}
```

A class with no explicit constructor whose super class HAS one fails the build with
`Constructor not exists` — declare `new()` even when its body is empty.

## `implements DI` Rewrites the Constructor — a Helper an Object OWNS Must Not Be One

The builder prepends a `provider: ServiceProvider` parameter, so a DI class can never be
built with arguments of your own:

```haxe
new Helper(a, b)   // Array<T> should be pony.ServiceProvider ... For function argument 'provider'
```

and the class is only reachable through the graph, so a `@:use` field in one nothing `@:own`s
fails separately with `DI: no producer for type "X" reachable from field "x"`. Both errors
name the plumbing rather than the mistake, which is that the class is in the graph at all.

The rule is ownership: `@:own` / `@:use` are for things the GRAPH creates. A helper some
object constructs itself is a plain class, and it takes what it needs as arguments. Prefer
passing the VALUE it reads over the service it would read it from — a helper handed the one
rectangle it measures against has no dependency to resolve, and the caller already has it.

## `@:listen(signal, cond)` Is the Whole State Machine

The conditional form subscribes and unsubscribes the handler as the condition flips, by
listening to the `changeX` signal of every `@:bindable` the condition reads. Compound
conditions, negation, own fields and fields reached through another object all work:

```haxe
@:listen(onTick, running)
@:listen(onTick, !grounded)
@:listen(onTick, phase != Phase.Idle)                   // enum abstract
@:listen(onTick, running && grounded)                   // re-checked on both
@:listen(onTick, running && count > LIMIT)              // bindable + constant
@:listen(onTick, running && horse.phase != Phase.Idle)  // own + through a field
```

What counts as a bindable is decided syntactically: an Upper-case-first identifier is a type
or enum constructor and is skipped (`Phase.Air`, `LIMIT`), as is a field declared in the class
without `@:bindable`. Method calls are invisible to the re-check — put the state in a field.
A condition reading no bindable is a positioned compile error.

`priority = N` orders a handler against the other listeners of the same signal (lower runs
earlier, default 0, ties keep subscription order). Without it the order is subscription order,
which for conditional listeners depends on when each condition first became true — not
obvious from reading the code:

```haxe
@:listen(DeltaTime.update, phase == Phase.Air, priority = -10) private function fly(dt: DT)
```

Historical note: before Aug 2026 the condition tracked only the FIRST identifier, `a && b`
silently re-checked on `a` alone, `!x` was a macro error, the `parent.field` form never
subscribed at all, and there was no `priority`. All fixed in `HasListenerBuilder`; see
`docs/listen.md` in the library.

Model mutually exclusive states as ONE `enum abstract` field rather than several booleans and
the whole state machine becomes declarative:

```haxe
@:bindable('private') private var phase: Phase = Phase.Idle;

@:listen(update, phase != Phase.Idle) private function tick(dt: DT)
@:listen(update, phase == Phase.Air)  private function fly(dt: DT)
@:listen(onPress, phase == Phase.Ground) private function jump()
@:listenOnce(onRelease, phase == Phase.Air) private function cut()
```

Assigning `phase` IS the transition — no manual `<<` / `>>` anywhere. `@:listenOnce` with a
condition re-arms on every entry into the state, giving "once per visit" for free.

Two more facts about the meta: several `@:listen` on the SAME method all take effect (handy
for one handler over several keys), and `@:bindable('private')` keeps the generated
`changeX` signal private so a private state field does not leak into the public API.

## `Signal1`'s `-` Operator Caches, So `@:listen(sig - value)` Is Stable

`sub(value)` scans existing listeners for a matching `LSub` and returns the SAME `Signal0`
each call. That is why `@:listen(Keyboard.down - Key.Space)` works at all — `listen()` and
`unlisten()` evaluate the expression separately and still address one signal.

## Keeping Content Inside the Visible Box: `drawBorders` Occludes, `Mask.scrollY` Clips Without Moving Anything

Two ready-made answers, and picking the wrong one costs a per-view refactor.

`HeapsApp.drawBorders(?color)` is pony's own: four filled rects around `canvas.stageInitSize`, added
at `s2d.add(border, 100)` in the engine's background colour, so everything outside the box is simply
covered. Nothing moves and no view learns anything — but it is pinned to `stageInitSize`, the FIXED
reference box. A game whose visible box is adaptive (clamped between a min and max height, so a
taller window means more scene rather than more border) gets its extra scene painted over. Reach for
it only when the box really is rigid.

For an adaptive box, make the scene itself an `h2d.Mask`. The trap is that moving the mask moves its
children, which turns a one-line change into a coordinate migration across every view. It does not
have to: `Mask` takes its clipping rectangle from its own `y`, and separately offsets its content by
MINUS `scrollY` —

```haxe
override function calcAbsPos() { super.calcAbsPos(); absX -= scrollX; absY -= scrollY; }
// and the clip rect:  y1 = object.absY + scrollY   // i.e. back to the un-scrolled y
```

— so setting both to the same value clips to that rectangle while leaving every child at the
coordinates it would have had with no mask at all:

```haxe
scene.y = scene.scrollY = box.y;
scene.height = Std.int(box.height);
```

One scissor for the whole tree also retires the reason individual views mask themselves: heaps floors
the scissor it derives from a mask (`Std.int` in `RenderContext.setRZ`), so two masks on the same
rectangle can disagree by a device pixel at a fractional window scale and leave a bright seam. One
mask cannot disagree with itself.

Clipping at the root is worth preferring on its own: a per-view mask is a rule every future view has
to remember, and forgetting it is invisible until something animates through the border.

## XML UI: Layouts Position Children ONCE — a Data-Driven Text Needs a `maxWidth`

`createUI` BUILDS the tree but does not position anything: `BaseLayoutCore.needUpdate()`
schedules its `endUpdate` on `DeltaTime.fixedUpdate`, so children get their `x`/`y` on the
NEXT frame. After that a layout only recomputes on an explicit `layout.update()` (or a stage
resize). So every box a layout reads has to be a box that does not move when a child's
content does.

**Reading a laid-out child's `x`/`y` in the constructor gives 0**, and nothing says so — the
values are simply the defaults, so code that offsets or measures from them lands every block
at the top-left corner of its parent and reads as a broken layout rather than as a timing
bug. Ask the layout instead of the frame counter: every `BaseLayout` is an `IWH`, and
`wait(cb)` fires once its core has arranged itself — immediately on every later call, since
readiness is latched. Reach it through the object whose layout actually SETS the position you
want: a block's own `wait` says nothing about whether its PARENT has placed it, so wait on
the outermost layout, which an `XmlUi` screen keeps as its first child (`createUI` does
`addChild(_createUI())`).

For a text that box is `GUIUtils.textSize` — **the declared `maxWidth`, or the current
string's width when it has none, by the line box, never by the ink**. Two consequences:

- Give a data-driven text a `maxWidth` and it owns that room whatever is put in it later.
  Heaps re-applies `maxWidth` + `align` itself on every `text` assignment, so a table is
  columns of `maxWidth` boxes and nothing else — no absolute `x`/`y`, no `update()` call.
  A text with NO `maxWidth` is still measured by its content, so a label that changes at
  runtime moves its neighbours' idea of where it ends.
- Vertically a label centres on its baseline, not on whichever glyphs are in it. (Before
  this was fixed the ink box was used, which put every label `dy / 2` low — a different
  amount per font size, and nothing in the XML explaining it.)

`h2d.Text` is not `IWH`, so this runs through `BaseLayout._getSize`; `DText` and
`ExtendedTextInput` reach the same helper from their own `size`.

Which layout you get is decided by attributes, not by a tag:

| Attributes | Layout | Behaviour |
|---|---|---|
| none | AlignLayout | children OVERLAP, each aligned in the box — this is how a label goes on top of a button |
| `iv` / `ih` | IntervalLayout | vertical / horizontal row with spacing |
| `w`/`h`/`wh` | RubberLayout | fixed box, arranges children in a row/column |
| `src` | BGLayout | image behind the children |

The checks are in that order, so `wh` on a node that also has `iv` is silently ignored —
wrap it in an outer sized layout instead.

## A Sized Root DISTRIBUTES Every Child — a Screen Has No Corner Slot Beside Its Column

The obvious way to put a small block in the empty space beside a centred screen — a credits
line, a version stamp, a corner button — is a second child on the screen's root layout. It
cannot work, and neither core says so at the XML level:

- a root with `w`/`h` is a `RubberLayoutCore`, whose `update` runs
  `GeomTools.center(size, sizes, vert, border, padding, align)`. That spreads EVERY child along
  the main axis and aligns them all identically on the cross axis, so a second child does not
  sit beside the first — it MOVES it;
- dropping the attributes to get an AlignLayout does not help either: `AlignLayoutCore` has no
  box of its own (`_w`/`_h` are its widest/tallest child) and applies one `_align` to all its
  children, so there is no per-child corner to align into. An explicit `x`/`y` on a child is
  the only offset it honours.

What DOES own a corner is a second whole-stage box: another `@:ui` view whose root is
`<layout w="stageWidth" h="stageHeight" align="bottom right" border="…">`, added to the same
scene and hung off the same rectangle every other screen measures itself against. One small
class, and the only shape that leaves the centred column untouched.

Measure before assuming the column has room at all: a screen laid out against the reference box
is only as tall as the SHORTEST the box ever gets, and a column tuned to fit there has no slack
by construction.

## `Button.size` Ignores `scaleX` — a Scaled Button Misaligns Its Neighbours

The button's own interactive area is built from `size * scale`, but the `IWH.size` a layout
reads is the raw node size. Put `scale="0.6"` on a button image inside an AlignLayout and
the layout still reserves the full-size box, so the label centred beside it lands about
half the unscaled width away. Use a different asset instead of scaling, or wrap the button
in a fixed-size layout that matches the scaled dimensions.

A `<button>`'s children are its visual states: 1 node → automatic tint on hover/press,
2 → swap, 3 → normal/hover/press, 4 → plus disabled. Labels are SIBLINGS of the button in
the surrounding layout, never children of it — a child would just become another state and
get hidden.

Building one in CODE — to make an existing sprite clickable without moving it into a layout —
takes `Node`s, not `Bitmap`s: `Button(nodes: Array<Node>, ?anim, ?parent)`, and
`new NodeBitmap(tile)` is what `Slice.create` itself picks for a single untyped tile. One node
is enough, since that is the automatic-tint case above. Its own `Interactive` is sized
`first.size.x * first.scaleX`, so a SCALED node does get the right hit area — the scale blindness
above is `IWH.size`, which only a layout reads.

## `format="libgdx"` Needs the LEGACY Data Layout

TexturePacker 8 writes the modern libgdx atlas (`bounds:` / `offsets:`). Neither heaps'
`hxd.res.Atlas` nor pony's own `<atlas>` binary converter parses it — both die on
`Unknown prop bounds` — they read `xy:` / `size:` / `orig:` / `offset:`. Pony's
`<texturepacker>` module passes `--libgdx-legacy-output true` for exactly this reason; if a
project drives TexturePacker by hand, it has to pass it too.

## `<texturepacker>`: One Invocation per `<unit>`, Names Relative to Each `<input>`

Each `<unit>` is its own TexturePacker run and its own atlas, so per-unit settings are how one
project mixes native-size art with scaled art. Every attribute may sit on `<texturepacker>`, a
nested `<path>`, or a single `<unit>`, inner winning — except `scale`, which MULTIPLIES through
the nesting instead of overriding.

Region names are relative to each `<input>` root, so moving one subdirectory into its own unit
renames everything under it (`ui/button` becomes `button`). Give art that needs different
packing settings a sibling ROOT directory rather than splitting an existing root.

`scale` interpolates, so downscaling pixel art needs `scaleMode="Fast"` (TexturePacker's
nearest neighbour) — plain `scale` blurs, and blowing the result back up gives mush instead of
bigger pixels. Size the factor by the pixel count you want, not the ratio: TexturePacker
rounds, so `1/3` of 70 lands on 23 and `0.35` lands on 24.

`AssetManager.texture(path, name)` addresses a region by atlas file AND name, and
`loadAllAssets` walks the whole `@:asset` list, so several atlases need no loader change — only
the right filename on each `@:asset` field.

## Rebuilding `tools/bin/pony` on macOS: DELETE the Binary First

`nekotools boot` writes the booted executable over the existing file. On Apple Silicon the
kernel then SIGKILLs it — every invocation exits 137 with NO output, and `codesign -v` reports
`main executable failed strict validation`. Re-signing does not fix it; a fresh inode does:

```sh
rm -f bin/pony && haxe build.hxml
```

Two traps around this. It breaks `pony` ENTIRELY, not just the command you were changing, so
the symptom shows up as "the build tool stopped working" long after the edit. And restoring a
known-good backup by copying OVER the broken file reproduces the same kill, which reads as
"my change was not the cause" — delete before copying, or the control experiment lies.

A sandboxed shell produces the identical 137-with-no-output on `pony prepare`, because that
command's `<download>` step reaches the network. Same exit code, unrelated cause: rule the
sandbox out before blaming the binary.

## Declare Every hxml in `pony.xml`, Including a Test Target

A hand-written `<name>.hxml` is off-convention: `<build>` generates them from
`<prepare hxml="name">`, and inside that block an unknown tag becomes `-<tag> <value>` while a
few are special (`d` → `-D`, `m` → `--macro`, `cmd` → `--cmd`, `k` → `--macro keep`). The
project's `<haxelib>` libs are prepended automatically with any ` dev` suffix stripped, so the
block lists only what is extra. `<build><hxml>name</hxml></build>` then runs `haxe name.hxml`.

Put a test target's blocks OUTSIDE `<apps>` — it belongs to no platform, so any build compiles
it and a test that stopped compiling is caught everywhere. `haxe name.hxml` is run with no
`-D app=...`, so a target that needs the app define must carry it itself (`<d name="app">js</d>`).
Config values from plain `<config>` nodes are unaffected — `ConfigBuilder` reads `pony.xml` at
macro time, not through hxml defines, which is what lets a test target see the same constants as
the game with no plumbing.

## NEVER Put `--cmd` / `--run` in an hxml Pony Compiles — Use `<run>`

`Build.runCompilation` spawns the compiler through `sys.io.Process` and reads only
`process.stderr` (it filters haxe's warnings there); `process.stdout` is never read. Two
consequences, and the second one is brutal:

- everything the compiler's child writes to stdout is silently discarded, so a `--cmd`'s output
  simply does not exist;
- a child that writes past the pipe buffer (~64 KB) blocks on `write` forever while pony blocks
  on `readLine` — the build hangs with no error and no timeout.

`stderr` is unaffected, which is what hides it: haxe's own diagnostics arrive normally, so a
failing build still looks like it reported itself. The `winfix` branch and every other module
(`Run`, `Test`, …) go through `Utils.command` → `Sys.command`, which inherits stdio and is fine.

So declare the command in `<run>` and let the hxml only compile:

```xml
<run>
    <command>node bin/test.js</command>
</run>
```

`pony run <app>` raises the Build section BEFORE the Run one — verified by deleting the output
binary and watching `pony run` rebuild it — so `pony run test` compiles and then runs, and the
Run module's non-zero exit still fails the command. Do not conclude otherwise from
`Module.addListeners`, where each command appears to bind exactly one section.

The `<test>` module is a third route: it also uses `Utils.command`, but its nodes default to the
Build section, so it is a build-time gate rather than a command of its own.

## The Pointer OWNS `ButtonCore.state` — Keyboard Focus Has To Be Re-Asserted

`ButtonCore`'s constructor wires `touch.onOut` and `touch.onOutUp` to `state = Default`, so
ANY code that sets `state = Focus` to show a keyboard selection is overwritten the moment the
cursor leaves that button — and heaps delivers one such out event on the FIRST frame, before
the pointer has been anywhere, which silently kills a selection made during startup.

Put it back by subscribing to the same two signals AFTER `ButtonCore` did:

```haxe
for (index => button in buttons) {
    button.core.touch.onOut << reselectHandler.bind(index);
    button.core.touch.onOutUp << reselectHandler.bind(index);
}
```

Do NOT do this from `changeState`: writing a `@:bindable` inside its own `changeX` dispatch is
reentrant and breaks the signal for the rest of that dispatch — the observed symptom was plain
mouse hover going dead, not an exception.

## A Listener Subscribed MID-Dispatch Can Still Receive That Same Event

`Signal.dispatch` walks a `Priority` that tolerates insertion during iteration, so a handler
added while the signal is dispatching may be reached by the very dispatch that added it. This
bites when one screen hands control to another on a key: the first screen's handler shows the
second, the second arms its own `@:listen(Keyboard.down - Key.Enter, active)` as `active` flips,
and the SAME Enter press then activates it — one key does two things.

Hand over a frame later instead:

```haxe
@:listen(over.onContinue) private function continueHandler(): Void DeltaTime.skipUpdate(finish);
```

But a frame of delay only covers the half of the physical press that armed the new screen.
A handler that acts on `Keyboard.up` — a button that clicks on release, so it can show itself
pushed in while the key is held — receives the release of a press it never saw: the human holds
the key ~100 ms, several frames, so the new screen is long armed by then. Gate the release on a
press THIS screen recorded, not on "am I the current screen":

```haxe
@:bindable('private') private var pressed: Bool = false;

@:listen(Keyboard.down - Key.Enter, active && ...) private function pressHandler(): Void {
    pressed = true;
    ...
}

@:listen(Keyboard.up - Key.Enter, pressed) private function releaseHandler(): Void {
    pressed = false;  // unsubscribes this handler inside its own dispatch, so no double click
    ...
}
```

Clear the flag anywhere the selection moves too, or a release after the selection changed indexes
a button that is no longer there.

## `ButtonCore.mode` Is a SECOND Visual Axis — Skin Sets Multiply With `state`

`ButtonCore` carries two independent bindables, and `Button.visualNHandler` multiplies them, so
"coloured for the keyboard AND outlined on hover" needs no library change:

| `mode` | nodes used |
|---|---|
| 0 | 0, 1, 2 — Default / Focus+Leave / Press |
| — | 3 — shown only while `lowMode == 1`, i.e. disabled |
| 1 | 4, 5, 6 — the same three states in the second skin set |
| 2 | 7, 8, 9 |

So a 7-node button is one full state triple per skin set plus the disabled slot; the slot is
mandatory even when nothing ever disables the button, because the index arithmetic
(`mode--; mode *= 3; mode++`) counts through it. `index >= nodes.length` CLAMPS to the last node,
so a 6-node button silently draws its selected-Press as selected-Focus rather than erroring.

`mode` is the public knob (`core.mode = 1`, or `core.bMode` / `bswitch()` for a two-set toggle);
`lowMode` is the internal one that `onVisual` actually carries — `mode = v` sets
`lowMode = v != 0 ? v + 1 : v`, which is how index 3 stays reserved. Driving keyboard selection
through `mode` instead of forging `state = Focus` also retires the `touch.onOut` re-assertion
above: the pointer keeps sole ownership of `state`, so nothing has to be put back.

## XML UI Has `<include>`

`<include>other.xml</include>` splices another file's tree in place, resolved relative to the
including file's directory. Generated ids get the INCLUDING context's prefix, so the same block
reused on two screens yields the same field names in both classes — but they are fields of two
different classes, so only the markup is shared, not the code that fills it.

## `Drawable.colorAdd` Cannot Be CLEARED Under `@:nullSafety(Strict)`

The property is declared `Null<h3d.Vector>` but its setter takes a non-null `h3d.Vector`, so
setting one compiles and putting it back does not:

```haxe
drawable.colorAdd = new Vector();   // ✓ brightens toward white — `color` MULTIPLIES and can only darken
drawable.colorAdd = null;           // ✗ Null safety: Cannot pass nullable value to
                                    //   not-nullable argument "c" of function "set_colorAdd"
```

The sugar's whole clearing path is that assignment, so a Strict class has to own the shader
instead — which is also the cheaper shape, since the setter adds and removes a shader per
assignment while a held one is just a field write:

```haxe
final white: ColorAdd = drawable.addShader(new ColorAdd());   // h3d.shader.ColorAdd, starts at black
white.color.set(v, v, v);                                     // per frame, mutated in place
drawable.removeShader(white);                                 // the clear
```

Reach for it whenever a sprite has to brighten rather than tint: `color` is a multiply, so no
value of it produces white. Not a reason for `@:nullSafety(Off)` — the library's declaration is
what is wrong, and going one layer down is the fix, not a workaround.

## Sound on js Is the Browser's Decoder, and heaps THROWS ITS OWN Gapless Correction Away

`hxd.snd.Mp3Data` reads the LAME tag and subtracts the encoder's delay and padding — on hl. On js
it hands the bytes to `decodeAudioData` and the callback then does `samples = buf.length`, which
overwrites that correction with whatever the browser's decoder produced. So an mp3 loop is
sample-exact on hl by construction and only as exact as the browser on js.

The seam itself is never a click: `Manager.getStreamBuffer` truncates the last buffer to exactly
`data.samples` and the webaudio driver schedules buffers end to end off the previous one's `ends`.
A wrong `samples` therefore costs SILENCE at the wrap, not a discontinuity — which is why it reads
as "the loop has a gap" rather than as anything broken.

Make it a number instead of an opinion: author the source at a whole number of seconds and assert
`Assets.sound(X).getData().duration` in the browser. Chromium honours the LAME tag (a 16.000 s
source decoded to exactly 768000 samples at 48 kHz), so mp3 is usable; ogg would be exact by
construction but needs `-lib stb_ogg_sound` on js or `hxd.res.Sound.getData()` throws, and its
pure-Haxe Vorbis decoder then runs per frame for anything past `OggData`'s three-second cache.

## A Per-Channel Volume Above 1 Is Web-Only — Level Correction Belongs in the Build

heaps drives WebAudio on js, where a gain above 1 is an ordinary multiplication, and OpenAL on hl,
where it CLAMPS at 1 — heaps concedes this itself with a `#if hlopenal` warning in `Manager.update`.
So "this sample was authored quiet, play it louder" written as `channel.volume = 2` comes out right
in a browser and flat on the desktop, and nothing in the code says why.

Correct the level where the asset is produced instead. Every channel volume then stays inside
0..1, the file ships at the level it plays at, and the whole balance is readable in one place.

## The Whole Mix Is What a Browser Judges — Measure the SUM, Not the Sounds

Everything sums at the output, and Safari holds a limiter across the entire `AudioContext`: when
the sum passes full scale it pulls the WHOLE mix down to fit. That is heard as one element dying —
typically the music, being the sustained one — rather than as anything being too loud, so the
report arrives as "the music stops" and points nowhere near the cause. Chromium passes the same
signal through distorted, so it does not reproduce.

The tell is a threshold on a VOLUME control ("it dies above 80%") plus a second sound source being
active. Measure before theorising, and measure the sum: wrap the context so `destination` returns
an `AnalyserNode` that feeds the real one, then poll `getFloatTimeDomainData` for the peak.
Anything over 1.0 is the bug. A music track mastered to a 0 dBFS peak leaves no room for a single
effect on top of it, so the fix is headroom — `Manager.get().masterVolume` is the one knob that
buys it for everything at once.

## Effects Can Starve the Music, and Two Knobs Stop Them

`Manager` binds channels to `MAX_SOURCES` (16) sources and virtualizes the rest, in the order
`sortChannel` decides: `channelGroup.priority` FIRST, then the channel's own `priority`, then
audible volume. A virtualized channel is not stopped — its position keeps advancing on wall clock,
so it silently plays on and comes back mid-stream.

- `SoundGroup.maxAudible` caps how many channels of that group may be audible; those it rejects do
  not consume the global budget (`--audibleCount`). This is the global voice limit, and it is a
  `SoundGroup`, NOT the `ChannelGroup` that carries a volume — a channel has one of each.
- Giving the music's `ChannelGroup` a higher `priority` makes losing a source something only
  effects can do.

## The Browser Audio Session Is Already Handled — `AudioSessionKeeper`, and the Now Playing Entry Is Deliberate

`HeapsApp` starts `pony.heaps.AudioSessionKeeper` on js. Do not re-derive any of this or add a
second mechanism beside it; `docs/audio-session.md` in the library carries the long form.

- **On iOS only `navigator.audioSession.type = 'playback'` is audible at all.** `auto`, `ambient`,
  `transient` and `transient-solo` all produce nothing from WebAudio, so a heaps game — which plays
  through WebAudio and nothing else — is mute under every one of them. Why is not established. A
  report of "no sound on iPhone" against an older build is this, not a regression: check what the
  session type is before bisecting anything.
- **A long screen lock tears that session down, and nothing in the page revives it.** The context
  keeps reporting `running` while its clock is frozen and no output reaches the speaker, and it
  stays dead past a page RELOAD — a freshly constructed `AudioContext` is dead too, so what died is
  the tab's session, not the document's. `resume()`, `suspend()`+`resume()`, a new context and
  re-requesting the type were each measured and each failed; only a tab switch or a browser restart
  brings it back. `<audio>` playback survives the same lock untouched, which is why the fix is a
  looping silent element holding the session open rather than any attempt at resurrection.
- **The Now Playing entry that appears while the game is backgrounded cannot be removed.** Dropping
  to `ambient` while hidden makes it disappear and the sound die with it; clearing
  `mediaSession.metadata` and `playbackState` leaves it standing. It is held by the playing element.
  `HeapsApp.initMediaSession` at least fills it from `<title>`, `<meta name="author">` and
  `<link rel="icon">`.
- **A hidden tab starves the streaming driver.** No `requestAnimationFrame` means no
  `Manager.update`, heard on desktop as stutter after a spell on another tab. `Manager.suspended`
  cannot fix it — that flag is applied inside `update`, which is exactly what stopped running.
  Suspending the `AudioContext` is what works. The GAME needs no pausing: the same
  `requestAnimationFrame` drives the heaps loop, and `hxd.Timer.update` discards any frame gap over
  `maxDeltaTime` (0.5 s), so the first frame back carries an ordinary `dt` — no teleport, no
  tunnelling.

Safari's favicon cache is keyed per host and caches "no icon" too, so a dev host hammered before the
icon existed shows the URL's first letter forever while every other site shows its icon. That is not
a markup bug — verify against a fresh host name before touching the `<link>`.

## `Keyboard.down` Dedupes a Held Key — `Keyboard.press` Is the Auto-Repeat

`Keyboard.downPress` returns early when the key is already in `pressedKeys`, so a held key
produces exactly one `down` however long the OS repeats it. The repeat lives on `press`, which
`pony.ui.Presser` re-dispatches for everything still held. Its rate is two public statics —
`Presser.pressFirstDelay` (500 ms before the first repeat) and `Presser.pressDelay` (200 ms
between them) — and they are GLOBAL to the program, not per listener.

So "holding this key should keep doing it" is `@:listen(Keyboard.press - Key.X, …)` rather than a
hand-rolled timer, and `down` stays right for anything that must happen once per physical press.

## `StepSlider` Only Drives the Axis It Slides Along

`changeX`/`changeY` are wired per orientation, so a horizontal slider never touches the knob's `y`.
A knob taller than its track therefore sits at the track's TOP with its overhang below, which reads
as misaligned rather than as unset — centre it yourself from the two heights.

Two more things about the `<slider>` tag: its first child is the background and every child after
that is a state of the knob's `Button` (so a single one gets the automatic hover/press tint), and
`sliderCore.onStartDrag` fires for the track as well as the knob, because the track's `onDown` calls
`startDrag`.

Set `percent`, not `value`, when moving a `StepSliderCore` from code: a percent is rounded on its
way to a value, where a value written straight in arrives unrounded and comes back out a second
time once the core has tidied it — two change events where the user made one. `setPosValue` is
worse still: its `update()` zeroes `pos` before re-clamping, which dispatches a spurious 0 first.

## On js `HeapsApp` Puts EVERY Listener on the Window, Which an iframe Takes Away

`HeapsApp` builds the heaps window as `new Window(canvas, true)` — `globalEvents = true` — and
that one flag decides the whole input surface: `hxd.Window` then binds mouse, touch, key and
focus to `js.Browser.window`, binds nothing to the canvas, and skips the branch that would have
given the canvas a `tabindex`. On a page of its own that is invisible, because the window
already has the focus and owns the gesture. Served inside an iframe — which is how itch.io and
most portals serve a build — two things break, and neither looks like an input bug from inside
the game:

- **Keys never arrive.** The surrounding page keeps the focus, and the click that would hand it
  over cannot: heaps' own canvas `mousedown` handler calls `preventDefault()`, whose default
  action IS the focus transfer. `HeapsApp` now takes it back explicitly on `pointerdown`.
- **A held finger cannot be told from a tap on iOS.** Safari keeps sending touch events only
  while the element under the finger carries a touch listener of its own. With every listener
  on the window, the first touch is the last: afterwards Safari synthesises a `mousedown` /
  `mouseup` pair at the LIFT, a millisecond apart, so press and release reach the game together
  and anything that reads press duration collapses. `HeapsApp.suppressTouchDefaults` gives the
  canvas its own `touchstart` / `touchmove` / `touchend`, so Safari keeps delivering.

The listener's EXISTENCE is only half of it — an empty one leaves the synthesised pair in place.
heaps registers `touchstart` / `touchmove` on the window WITHOUT `{passive: false}`, and on the
window those default to passive, so the `e.preventDefault()` at the top of its own `onTouchStart`
is dead code — and an unprevented touch is exactly what makes iOS synthesise the pair. With the
real touches restored, a tap then reaches the game TWICE: once from the touch and once from the
phantom `mousedown` + `mouseup` at the lift. The second arrival is invisible while the game is
mid-animation and lands as a phantom click the moment it has settled, which reads as an
intermittent one-frame twitch on release rather than as a double input. So the canvas listeners
must be `{passive: false}` and call `preventDefault()`.

Pair that with `canvas.style.touchAction = 'none'`, which is NOT a duplicate: `preventDefault` is
a main-thread answer the compositor waits for on a timeout, and across the process boundary of a
cross-origin iframe (itch.io serves the build from a different origin than the page) a busy frame
loses that race and the gesture starts anyway — that race is what makes the symptom intermittent.
Hit testing reads `touchAction` without asking the page. `touchAction` alone fixes nothing here:
compatibility mouse events are suppressed only by `preventDefault`. Measured on iOS: prevent-only
is correct but still occasionally twitchy, `touchAction`-only is as broken as neither, both is
clean. `touch-action` on the canvas suffices for touches landing on it — the effective value is
the intersection up the ancestor chain, so `none` on the target settles it.

## Command Sections Are a Priority Chain — `zip` Raises Build, Never Run

`Commands.hx`'s constructor wires the sections together: `onZip << eBuild`, `onFtp << eBuild`,
`onElectron << eBuild`, `onRun << eBuild`, plus `onCordova.add(eBuild, MINIMAL_PRIORITY)` and
`onAndroid` / `onIphone` chaining through `eCordova`. `<<` is `Priority.add(e, priority = 0)`, so
`pony zip <app>` raises Build then Zip — never Run. A command dispatches exactly one section
signal; this chaining in the constructor is the only place sections call each other.

`Module.addListeners` puts every module on every command signal twice: a `before` handler at
`CONFIG_PRIORITY + PRIORITY` and an `after` handler at plain `PRIORITY`, with `CONFIG_PRIORITY`
at -100 so config reading always goes first (lower priority runs earlier — `Priority.addToBegin`
uses `min - 1`, `addToEnd` uses `max + 1`). Since the chained `eBuild` sits at priority 0, a
module's own PRIORITY says where it lands relative to the WHOLE Build section rather than
relative to any one config: Build itself is 1, Uglify 3, Hashlink 10, Zip 12, Run 35 — all after
Build has already been queued in full.

Which config fires on which dispatch is not decided by which module declared it. `CfgModule.runModule`
only runs a config whose `cfg.before` and `cfg.section` both match, and `BAReader.readNode` accepts
`<before>`, `<after>`, and every section name (`prepare`, `build`, `run`, `zip`, `ftp`, `hash`,
`remote`, `unpack`, `server`, `cordova`, `android`, `iphone`, `electron`) as a nested tag that
re-targets the enclosing config — default is `before = false`, the `after` half. So a config can
sit inside any module's node and still fire on a different section entirely.

That is what makes Run usable as a deploy step: it is the only module that executes an arbitrary
command, and at PRIORITY 35 it is last in any dispatch, so hanging it off the section that
produced the artifact runs it right after:

```xml
<run><zip><command>curl -T out.zip ftp://...</command></zip></run>
```

runs the command once Zip (12) has written the archive — not on some separate Run section.
`Utils.command` calls `error()` on a non-zero exit, so a failing deploy command aborts the build
the same as a failing compile would.

## A Nested Section Tag Silences Its Own Node's Config

`XmlConfigReader._selfCreate` sets `allowEnd = false` on the PARENT reader before building a
child reader for a nested tag, and `readXml` only calls `end()` — which is what emits a config —
when `locAllowEnd && allowEnd` are BOTH still true. So the moment a node contains any nested
`<before>`, `<after>`, or section tag, that node's own directly-declared content (a `<command>`,
an `<input>`) stops producing a config, with nothing reported: the command just quietly does less
than the XML says. Adding a `<zip>` block inside a `<run>` node that already carried a plain
`<command>` disables that command and says nothing about it.

A second, related trap sits in `BAReader.createSection`: `final cfg = copyCfg(); clean();
cfg.section = section;` clones the current config BEFORE `clean()` runs, so whatever was already
read in that node leaks into the nested section's config instead of being isolated from it. Order
inside the node is load-bearing — put the shared parts before the nested section tag if they
should reach it, after if they should not.

The way out is that a module's root node is repeatable: `Module.get_nodes` resolves every
same-named child of the project root and `CfgModule.readConfig` iterates them independently, so
each section can get its OWN root node — two `<run>` blocks, two `<clean>` blocks — rather than
one node with branches nested inside it. Wrapping every branch in its own section tag works too,
but separate roots are the shape that leaves an existing block untouched when a new one is added
beside it.

`<apps>`, `<debug>` and `<release>` go through the same mechanism: `XmlConfigReader.readXml`
handles them for every module and sets `locAllowEnd = false` for the same reason, so app-scoping a
node is itself a silencer of that node's own bare content.

## `group` Is a CLI Opt-Out, and Only the Deny Direction Is Usable

`Main.setGroupsPerm` splits arguments by their first character: a leading `-name` goes to
`modules.deny`, `+name` to `modules.allow`, anything else stays an ordinary argument.
`Module.parseGroup` reads a `group` attribute (space-separated) off a module's root node,
`CfgModule.readConfig` stamps it onto every config that node produces, and
`Modules.checkAllowGroups` filters at dispatch time.

The catch is in that filter: `checkAllowGroups` treats a config with no group as always-allowed —
`allow.length == 0` passes. So `+name` on the command line does not mean "only this group" — it
suppresses every ungrouped node in the whole project, which in practice is most of them, so the
allow direction is nearly unusable. `-name` is the clean one: it opts a single tagged node out
without touching anything else, e.g. `pony zip js -deploy` still builds and packs but skips a
`<run group="deploy">` block.
