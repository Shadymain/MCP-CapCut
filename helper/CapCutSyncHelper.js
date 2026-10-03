// CapCut Sync Helper -- a tiny JXA applet that performs UI actions for the MCP server.
//
// Why it exists: MCP servers are started as their own "responsible process", so macOS asks for
// Accessibility and Automation permission for /usr/local/bin/node itself -- which would cover every
// Node script on the machine. This applet is launched with `open`, so macOS attributes the clicks
// to it alone, and only it needs those permissions.
//
// Keep this file generic and stable: macOS ties the permissions to this exact build, so every
// rebuild means allowing it again. Everything specific to CapCut (process name, menu titles, element
// descriptions, coordinates) arrives in the request file. Add a new op only when no existing one fits.
//
// Protocol (all files in ~/Library/Application Support/CapCut Sync Helper/):
//   request.json  written by the server: { id, expiresAt (ms epoch), steps: [{ op, ... }] }
//                 the helper deletes it as soon as it has read it
//   status.json   written by the helper before each step: { id, step, op, at }
//   result.json   written by the helper when done: { id, helperVersion, axTrusted, ok, results, error? }
// Steps run in order and stop at the first failure. If the request expires while a step is blocked
// (e.g. on a permission prompt), the remaining steps are skipped, so a late answer never clicks anything.
//
// Ops:
//   { op: 'delay', seconds }
//   { op: 'promptAccessibility' }        adds this app to the Accessibility list (shows the system prompt)
//   { op: 'processExists', process }     a harmless System Events query; triggers the Automation prompt
//   { op: 'clickMenu', process, path }   path: [menu bar item, (submenu...), menu item]
//   { op: 'findElements', process, description, windowSubrole? }
//                                        -> { windows: [[x,y,w,h]], elements: [[x,y,w,h]] }
//   { op: 'mouseClick', x, y, count? }   real mouse events (apps may ignore System Events' "click at")

ObjC.import('Foundation');
ObjC.import('CoreGraphics');
ObjC.import('ApplicationServices');

const HELPER_VERSION = 1;
const DIR = $.NSHomeDirectory().js + '/Library/Application Support/CapCut Sync Helper';

function readJson(p) {
  const s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null);
  return s.isNil() ? null : JSON.parse(s.js);
}
function writeJson(p, obj) {
  $(JSON.stringify(obj)).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, null);
}
function remove(p) { $.NSFileManager.defaultManager.removeItemAtPathError(p, null); }

function frame(el) { const p = el.position(), s = el.size(); return [p[0], p[1], s[0], s[1]]; }

function mouseClick(x, y, count) {
  const pt = $.CGPointMake(x, y);
  const post = (type, state) => {
    const e = $.CGEventCreateMouseEvent(null, type, pt, $.kCGMouseButtonLeft);
    if (state) $.CGEventSetIntegerValueField(e, $.kCGMouseEventClickState, state);
    $.CGEventPost($.kCGHIDEventTap, e);
  };
  post($.kCGEventMouseMoved, 0); delay(0.4);
  for (let i = 1; i <= count; i++) {
    post($.kCGEventLeftMouseDown, i); delay(0.03); post($.kCGEventLeftMouseUp, i);
    if (i < count) delay(0.08);
  }
}

function runStep(s) {
  const se = () => Application('System Events');
  switch (s.op) {
    case 'delay': delay(Number(s.seconds) || 0); return {};
    case 'promptAccessibility': {
      const opts = $.NSDictionary.dictionaryWithObjectForKey($.kCFBooleanTrue, $('AXTrustedCheckOptionPrompt'));
      return { axTrusted: !!$.AXIsProcessTrustedWithOptions(opts) };
    }
    case 'processExists': return { exists: se().processes.name().includes(s.process) }; // exists() sends no Apple Event
    case 'clickMenu': {
      const path = s.path || [];
      if (path.length < 2) throw new Error('clickMenu needs a path of at least [menu bar item, menu item]');
      let menu = se().processes.byName(s.process).menuBars[0].menuBarItems.byName(path[0]).menus[0];
      for (const name of path.slice(1, -1)) menu = menu.menuItems.byName(name).menus[0];
      menu.menuItems.byName(path[path.length - 1]).click();
      return {};
    }
    case 'findElements': {
      const windows = [], elements = [];
      for (const w of se().processes.byName(s.process).windows()) {
        if (s.windowSubrole && w.subrole() !== s.windowSubrole) continue;
        windows.push(frame(w));
        for (const el of w.entireContents()) { // a snapshot: walking the live reference finds nothing
          let d = '';
          try { d = String(el.description()); } catch (e) { /* element has no description */ }
          if (d === s.description) elements.push(frame(el));
        }
      }
      return { windows, elements };
    }
    case 'mouseClick': mouseClick(Number(s.x), Number(s.y), Number(s.count) || 1); return {};
    default: throw new Error(`unknown op "${s.op}" (this helper is version ${HELPER_VERSION})`);
  }
}

function run() {
  const reqPath = DIR + '/request.json';
  let req;
  try { req = readJson(reqPath); } catch (e) { req = null; }
  remove(reqPath);
  if (!req) return;

  const result = { id: req.id, helperVersion: HELPER_VERSION, axTrusted: !!$.AXIsProcessTrusted(), ok: true, results: [] };
  const steps = req.steps || [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (req.expiresAt && Date.now() > req.expiresAt) {
      result.ok = false;
      result.error = { step: i, op: s.op, message: 'request expired before this step ran; skipped it', expired: true };
      break;
    }
    writeJson(DIR + '/status.json', { id: req.id, step: i, op: s.op, at: Date.now() });
    try { result.results.push(runStep(s)); }
    catch (e) {
      result.ok = false;
      result.error = { step: i, op: s.op, message: String(e.message || e), number: e.errorNumber == null ? null : e.errorNumber };
      break;
    }
  }
  writeJson(DIR + '/result.json', result);
}
