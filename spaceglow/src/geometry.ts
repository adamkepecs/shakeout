import { TAU } from "./settings.ts";

export function vec(x = 0, y = 0) {
  return { x, y };
}

export function clonePoint(point) {
  return { x: point.x, y: point.y };
}

export function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(point, amount) {
  return { x: point.x * amount, y: point.y * amount };
}

export function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

export function length(point) {
  return Math.hypot(point.x, point.y);
}

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function normalize(point) {
  const len = length(point);
  if (len <= 0.000001) return { x: 1, y: 0 };
  return { x: point.x / len, y: point.y / len };
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function lerpPoint(a, b, t) {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

export function easeInOutCubic(t) {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function wrapRadians(angle) {
  let wrapped = angle % TAU;
  if (wrapped < 0) wrapped += TAU;
  return wrapped;
}

export function signedAngleDelta(current, target) {
  return Math.atan2(Math.sin(current - target), Math.cos(current - target));
}

export function orbitPoint(center, radius, angle) {
  return {
    x: center.x + Math.cos(angle) * radius,
    y: center.y + Math.sin(angle) * radius,
  };
}

export function tangentDirection(angle) {
  return normalize({ x: -Math.sin(angle), y: Math.cos(angle) });
}

export function idealLaunchAngle(currentNode, targetNode, orbitRadius) {
  const toTarget = sub(targetNode, currentNode);
  const d = length(toTarget);
  if (d <= orbitRadius + 0.001) return 0;

  const theta = Math.atan2(toTarget.y, toTarget.x);
  const offset = Math.acos(clamp(orbitRadius / d, -1, 1));
  const candidates = [wrapRadians(theta + offset), wrapRadians(theta - offset)];

  let best = candidates[0];
  let bestDot = -Infinity;
  for (const candidate of candidates) {
    const point = orbitPoint(currentNode, orbitRadius, candidate);
    const velocity = tangentDirection(candidate);
    const towardTarget = normalize(sub(targetNode, point));
    const alignment = dot(velocity, towardTarget);
    if (alignment > bestDot) {
      bestDot = alignment;
      best = candidate;
    }
  }
  return best;
}

export function rayCircleIntersectionDistance(origin, direction, center, radius) {
  const oc = sub(origin, center);
  const b = 2 * dot(oc, direction);
  const c = dot(oc, oc) - radius * radius;
  const discriminant = b * b - 4 * c;
  if (discriminant < 0) return null;

  const sqrt = Math.sqrt(discriminant);
  const t1 = (-b - sqrt) / 2;
  const t2 = (-b + sqrt) / 2;
  if (t1 >= 0) return t1;
  if (t2 >= 0) return t2;
  return null;
}

export function pointWithinBounds(point, width, height, margin) {
  return (
    point.x >= margin &&
    point.y >= margin &&
    point.x <= width - margin &&
    point.y <= height - margin
  );
}
