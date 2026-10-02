// t0-grid.mjs — spatialGrid regression: 10 targeted checks.
// The broad-phase must index every covered cell (a shared-scratch aliasing bug
// once collapsed min/max to one cell, letting projectiles pass through).
// Run: node tests/node/t0-grid.mjs
import './_env.mjs';
import { clearGrid, insertObject, queryNearby, CELL_SIZE, getGridStats } from '../../src/physics.js';

let passes = 0, failures = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  PASS  ' + msg); }
  else { failures++; console.log('  FAIL  ' + msg); }
}
const out = [];
const q = (x, y, r) => { queryNearby(x, y, r, out); return out.slice(); };

// 1. basic insert/query roundtrip.
clearGrid();
insertObject('a', 100, 100, 10);
ok(q(100, 100, 10).includes('a'), 'roundtrip');
// 2. multi-cell coverage: radius spanning 2x2 cells is found from each corner.
clearGrid();
insertObject('big', 200, 200, 150);
ok(q(60, 60, 5).includes('big') && q(340, 340, 5).includes('big') && q(60, 340, 5).includes('big') && q(340, 60, 5).includes('big'), '2x2 cell coverage from all corners');
// 3. the shuriken case: fighter and query in adjacent cells still meet.
clearGrid();
insertObject('fighter', 530, 826, 81);
ok(q(528, 820, 58).includes('fighter'), 'adjacent-cell broad-phase hit');
// 4. far objects are excluded.
clearGrid();
insertObject('far', 1000, 1000, 10);
ok(!q(100, 100, 10).includes('far'), 'distant excluded');
// 5. clearGrid empties.
clearGrid();
insertObject('x', 50, 50, 5);
clearGrid();
ok(q(50, 50, 50).length === 0, 'clearGrid empties');
// 6. negative coordinates work.
clearGrid();
insertObject('neg', -150, -300, 20);
ok(q(-150, -300, 20).includes('neg'), 'negative coords');
// 7. zero-radius point query on an exact cell.
clearGrid();
insertObject('p', 400, 400, 0);
ok(q(400, 400, 0).includes('p'), 'zero-radius point');
// 8. multiple objects accumulate, out array reused not reallocated.
clearGrid();
insertObject('o1', 10, 10, 5);
insertObject('o2', 12, 12, 5);
const r = q(11, 11, 30);
ok(r.includes('o1') && r.includes('o2') && Array.isArray(out), 'multi-object + reuse');
// 9. stats reflect indexed cells (>1 cell for a spanning insert).
clearGrid();
insertObject('s', 200, 200, 150);
ok(getGridStats().cells >= 4, `spanning insert touches ${getGridStats().cells} cells`);
clearGrid();
// 10. query does not mutate the grid.
insertObject('m', 70, 70, 5);
const before = getGridStats().totalEntries;
q(70, 70, 200);
ok(getGridStats().totalEntries === before, 'query is read-only');

console.log(`== t0: ${passes} passed, ${failures} failed ==`);
process.exit(failures ? 1 : 0);
