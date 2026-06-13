function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function moveToward(targetX, targetY, x, y) {
  const dx = targetX - x;
  const dy = targetY - y;
  if (Math.abs(dx) > Math.abs(dy)) {
    return { x: x + Math.sign(dx), y };
  }
  if (Math.abs(dy) > 0) {
    return { x, y: y + Math.sign(dy) };
  }
  return { x, y };
}

module.exports = {
  randInt,
  clamp,
  moveToward,
};
