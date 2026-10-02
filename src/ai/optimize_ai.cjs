const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'ai.js');
let content = fs.readFileSync(filePath, 'utf8');

// Find the buildPerception function and add caching
const buildPerceptionIdx = content.indexOf('function buildPerception(f, opp, stage) {');
if (buildPerceptionIdx === -1) {
    console.error('Could not find buildPerception function');
    process.exit(1);
}

// Add a cache object before the function
const cacheCode = `
// Perception cache to avoid redundant calculations
const _perceptionCache = new Map();
const _perceptionCacheKey = (f, opp, stage) => {
    const fx = Math.round(f.x * 0.1) * 10;  // Round to nearest 10px
    const fy = Math.round(f.y * 0.1) * 10;
    const ox = opp ? Math.round(opp.x * 0.1) * 10 : 0;
    const oy = opp ? Math.round(opp.y * 0.1) * 10 : 0;
    const fvx = Math.round(f.vx);
    const fvy = Math.round(f.vy);
    const ovx = opp ? Math.round(opp.vx) : 0;
    const ovy = opp ? Math.round(opp.vy) : 0;
    const fState = f.state || 'idle';
    const oState = opp ? opp.state || 'idle' : 'none';
    const fGrounded = f.grounded ? 1 : 0;
    const oGrounded = opp ? (opp.grounded ? 1 : 0) : 0;
    return \`\${fx},\${fy},\${ox},\${oy},\${fvx},\${fvy},\${ovx},\${ovy},\${fState},\${oState},\${fGrounded},\${oGrounded}\`;
};

// Cached ground platform reference
let _cachedGround = null;
let _cachedStage = null;
function getCachedGround(stage) {
    if (stage !== _cachedStage) {
        _cachedStage = stage;
        _cachedGround = mainGround(stage);
    }
    return _cachedGround;
}
`;

// Insert cache code before buildPerception
content = content.slice(0, buildPerceptionIdx) + cacheCode + '\n' + content.slice(buildPerceptionIdx);

// Now modify buildPerception to use caching
const funcStart = content.indexOf('function buildPerception(f, opp, stage) {', buildPerceptionIdx + cacheCode.length);
let braceCount = 0;
let inFunction = false;
let funcEnd = funcStart;
for (let i = funcStart; i < content.length; i++) {
    if (content[i] === '{') {
        braceCount++;
        inFunction = true;
    } else if (content[i] === '}') {
        braceCount--;
        if (inFunction && braceCount === 0) {
            funcEnd = i + 1;
            break;
        }
    }
}

const oldFunc = content.slice(funcStart, funcEnd);

// Replace the beginning of the function to add caching
const newFuncStart = `function buildPerception(f, opp, stage) {
  // Check cache first
  const cacheKey = _perceptionCacheKey(f, opp, stage);
  const cached = _perceptionCache.get(cacheKey);
  if (cached && (performance.now() - cached.time) < 50) {  // Cache valid for 50ms
      return cached.data;
  }
`;

let newFunc = content.slice(funcStart, funcEnd);
newFunc = newFunc.replace('function buildPerception(f, opp, stage) {\n', newFuncStart);

// Add caching at the end of the function (before the return)
newFunc = newFunc.replace(
    'return {',
    `  const result = {
`)
newFunc = newFunc.replace(
    '  };',
    `  };
  // Cache the result
  _perceptionCache.set(cacheKey, { data: result, time: performance.now() });
  // Limit cache size
  if (_perceptionCache.size > 256) {
      const firstKey = _perceptionCache.keys().next().value;
      _perceptionCache.delete(firstKey);
  }
  return result;`
);

// Replace the function in content
content = content.slice(0, funcStart) + newFunc + content.slice(funcEnd);

fs.writeFileSync(filePath, content, 'utf8');
console.log('AI perception caching added successfully');