/**
 * Rep Sheet: a workout logger web app (Apps Script) bound to a Google Sheet.
 *
 * Sheets (created automatically on first use):
 *   Log    - the dataset. One row per set, append-only. Treat it as tidy data.
 *   Config - one column per workout type. Row 1 = type name, rows below = exercises.
 *            Edit it freely; the app picks up changes on next load.
 */

const LOG_SHEET = 'Log';
const CONFIG_SHEET = 'Config';
const DEFAULT_UNIT = 'lb';

const APP_NAME = 'Rep Sheet';
// Home-screen / tab icon. Must be a public https URL ending in .png; Chrome on
// Android uses it for "Add to Home screen". Leave '' for the default icon.
const ICON_URL = 'https://raw.githubusercontent.com/bryan-n-arch/rep-sheet/main/assets/icon.png';

// Column order of the Log sheet. Append new columns at the END only, so
// existing data and any downstream analysis code keep working.
const LOG_COLUMNS = [
  'session_date', // yyyy-mm-dd the workout happened (user-editable, for late entries)
  'workout_type', // e.g. "Upper A"
  'exercise',     // movement first, variant in parens, e.g. "Bench Press (Incline)"
  'set_number',   // 1-based, per exercise within a session
  'weight',
  'reps',
  'unit',         // "lb" / "kg"
  'rpe',          // optional, 1-10
  'notes',        // optional
  'logged_at',    // when the set was entered on the phone (not necessarily when it was performed)
  'session_id',   // "<session_date>_<workout-type-slug>", groups a workout
  'set_id',       // uuid generated on the phone; makes retries idempotent
];
const COL = Object.fromEntries(LOG_COLUMNS.map((name, i) => [name, i]));

const LOG_FORMATS = LOG_COLUMNS.map((name) => {
  if (name === 'session_date') return 'yyyy-mm-dd';
  if (name === 'logged_at') return 'yyyy-mm-dd hh:mm:ss';
  if (name === 'weight' || name === 'rpe') return '0.##';
  if (name === 'set_number' || name === 'reps') return '0';
  return '@';
});

// Exercise names: movement first, variant in parens, so related lifts sort together.
const DEFAULT_CONFIG = {
  'Upper A': ['Bench Press (Flat)', 'Lat Pulldown', 'Tricep Overhead Extension', 'Seated Row (Cable)', 'Lateral Raise (Cable)', 'Bayesian Curl'],
  'Upper B': ['Bench Press (Incline)', 'Lat Pulldown', 'Chest Fly (Cable)', 'Seated Row (Cable)', 'Tricep Pulldown', 'Preacher Curl (Cable)', 'Lateral Raise (Cable)'],
  'Lower A': ['Squat', 'Deadlift', 'Leg Curl (Cable)', 'Leg Extension (Cable)', 'Hip Thrust'],
  'Lower B': ['Squat', 'Calf Raise', 'Leg Curl (Cable)', 'Leg Extension (Cable)', 'Hip Thrust', 'Deadlift'],
};

// ---------------------------------------------------------------------------
// Web app entry point

function doGet(e) {
  const template = HtmlService.createTemplateFromFile('Index');
  // Embed the initial state so the page renders without a second round trip.
  // ?dry=1 opens a practice mode where nothing is written to the Sheet.
  const dryRun = !!(e && e.parameter && e.parameter.dry);
  template.bootJson = JSON.stringify({ ...getState(today_()), dryRun }).replace(/</g, '\\u003c');
  const page = template.evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    .addMetaTag('mobile-web-app-capable', 'yes');
  if (ICON_URL) page.setFaviconUrl(ICON_URL);
  return page;
}

/** Run once from the Apps Script editor: grants permissions and creates the tabs. */
function setup() {
  logSheet_();
  configSheet_();
}

// ---------------------------------------------------------------------------
// API called from the page via google.script.run

/**
 * Everything the page needs for one date: config, sets logged that day, and
 * the previous session's sets for every exercise (for "last time" hints).
 */
function getState(sessionDate) {
  sessionDate = parseDate_(sessionDate);
  const rows = readLog_();

  const sets = rows.filter((r) => r.session_date === sessionDate);

  // Most recent earlier session per exercise.
  const last = {};
  for (const r of rows) {
    if (r.session_date >= sessionDate) continue;
    const cur = last[r.exercise];
    if (!cur || r.session_date > cur.session_date) {
      last[r.exercise] = { session_date: r.session_date, workout_type: r.workout_type, sets: [r] };
    } else if (r.session_date === cur.session_date) {
      cur.sets.push(r);
    }
  }
  for (const v of Object.values(last)) {
    v.sets.sort((a, b) => a.set_number - b.set_number);
    v.sets = v.sets.map((s) => ({ weight: s.weight, reps: s.reps, unit: s.unit }));
  }

  // Workout types trained on each date, for the calendar.
  const workoutDays = {};
  for (const r of rows) {
    const types = (workoutDays[r.session_date] = workoutDays[r.session_date] || []);
    if (!types.includes(r.workout_type)) types.push(r.workout_type);
  }

  return { today: today_(), sessionDate, config: readConfig_(), defaultUnit: DEFAULT_UNIT, sets, last, workoutDays };
}

/** Append one set. Idempotent on set_id. Returns the stored row. */
function logSet(input) {
  const set = validateSet_(input);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = logSheet_();
    const rows = readLog_(sheet);

    const existing = rows.find((r) => r.set_id === set.set_id);
    if (existing) return existing;

    const sameExercise = rows.filter((r) => r.session_id === set.session_id && r.exercise === set.exercise);
    set.set_number = sameExercise.reduce((max, r) => Math.max(max, r.set_number), 0) + 1;

    sheet.appendRow(rowValues_(set));
    sheet.getRange(sheet.getLastRow(), 1, 1, LOG_COLUMNS.length).setNumberFormats([LOG_FORMATS]);
    return set;
  } finally {
    lock.releaseLock();
  }
}

/** Delete one set by set_id. Returns true if a row was removed. */
function deleteSet(setId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = logSheet_();
    const ids = sheet.getRange(1, COL.set_id + 1, sheet.getLastRow(), 1).getValues();
    for (let i = ids.length - 1; i >= 1; i--) {
      if (ids[i][0] === setId) {
        sheet.deleteRow(i + 1);
        return true;
      }
    }
    return false;
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Sheet access

function spreadsheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = Session.getScriptTimeZone();
  if (ss.getSpreadsheetTimeZone() !== tz) ss.setSpreadsheetTimeZone(tz);
  return ss;
}

function logSheet_() {
  const ss = spreadsheet_();
  let sheet = ss.getSheetByName(LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET, 0);
    sheet.getRange(1, 1, 1, LOG_COLUMNS.length).setValues([LOG_COLUMNS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    const unused = ss.getSheetByName('Sheet1');
    if (unused && unused.getLastRow() === 0) ss.deleteSheet(unused);
  }
  return sheet;
}

function configSheet_() {
  const ss = spreadsheet_();
  let sheet = ss.getSheetByName(CONFIG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG_SHEET);
    writeConfig_(sheet, DEFAULT_CONFIG);
  }
  return sheet;
}

/** Overwrite the Config tab with { type: [exercises] }. */
function writeConfig_(sheet, config) {
  const types = Object.keys(config);
  const height = Math.max(...types.map((t) => config[t].length)) + 1;
  const grid = [];
  for (let r = 0; r < height; r++) {
    grid.push(types.map((t) => (r === 0 ? t : config[t][r - 1] || '')));
  }
  sheet.clear();
  sheet.getRange(1, 1, height, types.length).setValues(grid);
  sheet.getRange(1, 1, 1, types.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

/** A set object as a Log row, in LOG_COLUMNS order. */
function rowValues_(set) {
  return LOG_COLUMNS.map((name) => {
    if (name === 'session_date') return dateFromIso_(set.session_date);
    if (name === 'logged_at') return set.logged_at ? new Date(set.logged_at) : '';
    return set[name];
  });
}

/** Log rows as plain objects (dates as strings, safe to return to the client). */
function readLog_(sheet) {
  sheet = sheet || logSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const tz = Session.getScriptTimeZone();
  return sheet.getRange(2, 1, lastRow - 1, LOG_COLUMNS.length).getValues().map((row) => {
    const obj = {};
    LOG_COLUMNS.forEach((name, i) => { obj[name] = row[i]; });
    obj.session_date = obj.session_date instanceof Date
      ? Utilities.formatDate(obj.session_date, tz, 'yyyy-MM-dd')
      : String(obj.session_date);
    obj.logged_at = obj.logged_at instanceof Date ? obj.logged_at.toISOString() : String(obj.logged_at);
    return obj;
  });
}

/** { types: [...], exercises: { type: [...] } } from the Config sheet. */
function readConfig_() {
  const values = configSheet_().getDataRange().getValues();
  const types = [];
  const exercises = {};
  (values[0] || []).forEach((header, c) => {
    const type = clean_(header);
    if (!type) return;
    types.push(type);
    exercises[type] = values.slice(1).map((row) => clean_(row[c])).filter(Boolean);
  });
  return { types, exercises };
}

// ---------------------------------------------------------------------------
// Helpers

function validateSet_(input) {
  input = input || {};
  const session_date = parseDate_(input.session_date);
  const workout_type = clean_(input.workout_type);
  const exercise = clean_(input.exercise);
  const weight = Number(input.weight);
  const reps = Number(input.reps);
  const rpe = input.rpe === '' || input.rpe == null ? '' : Number(input.rpe);
  const loggedAt = new Date(input.logged_at);

  if (!workout_type) throw new Error('Missing workout type');
  if (!exercise) throw new Error('Missing exercise');
  if (!isFinite(weight) || weight < 0) throw new Error('Weight must be a number >= 0');
  if (!Number.isInteger(reps) || reps < 1) throw new Error('Reps must be a whole number >= 1');
  if (rpe !== '' && (!isFinite(rpe) || rpe < 1 || rpe > 10)) throw new Error('RPE must be 1-10');
  if (!input.set_id) throw new Error('Missing set_id');

  return {
    session_date,
    workout_type,
    exercise,
    set_number: 0,
    weight,
    reps,
    unit: clean_(input.unit) || DEFAULT_UNIT,
    rpe,
    notes: clean_(input.notes),
    // Phone clock at tap time (sets may be queued offline); fall back to now.
    logged_at: (isNaN(loggedAt.getTime()) ? new Date() : loggedAt).toISOString(),
    session_id: `${session_date}_${slug_(workout_type)}`,
    set_id: String(input.set_id),
  };
}

function today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function parseDate_(s) {
  s = String(s || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Bad date: ${s}`);
  return s;
}

function dateFromIso_(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function clean_(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function slug_(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
