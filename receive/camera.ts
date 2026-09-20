/** ImageCapture extras used by Chrome/Android (not in every lib.dom version). */
export type QrTrackCapabilities = {
  focusMode?: string[];
  focusDistance?: { min: number; max: number; step?: number };
  zoom?: { min: number; max: number; step?: number };
  pointsOfInterest?: boolean;
};

export type FocusPoint = { x: number; y: number };

export type FocusModePref = "continuous" | "single-shot" | "auto";

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/** Distance for a QR on a nearby screen (typically 20–40 cm). */
export function pickCloseFocusDistance(range: { min: number; max: number }): number {
  const min = range.min;
  const max = range.max;
  if (!(max > min)) return min;
  const targetMeters = 0.28;
  if (targetMeters >= min && targetMeters <= max) return targetMeters;
  return min + (max - min) * 0.22;
}

/**
 * Prefer a mild tele zoom. Cheap phones often default to ultra-wide (zoom < 1),
 * which keeps the QR tiny and the lens focused toward infinity.
 */
export function pickQrZoom(range: { min: number; max: number }): number | null {
  const min = range.min;
  const max = range.max;
  if (!(max > min)) return null;
  const want = 1.35;
  const z = Math.min(max, Math.max(min, want));
  if (min < 0.95) return z;
  if (z < min + 0.12) return null;
  return z;
}

export function chooseFocusMode(modes: string[] | undefined, pref: FocusModePref): string | undefined {
  const list = modes ?? [];
  if (pref === "continuous" && list.includes("continuous")) return "continuous";
  if (pref === "single-shot" && list.includes("single-shot")) return "single-shot";
  if (list.includes("continuous")) return "continuous";
  if (list.includes("single-shot")) return "single-shot";
  return undefined;
}

export function qrFocusAdvanced(
  caps: QrTrackCapabilities,
  point: FocusPoint = { x: 0.5, y: 0.5 },
  pref: FocusModePref = "auto",
): Record<string, unknown> | null {
  const advanced: Record<string, unknown> = {};
  const focusMode = chooseFocusMode(caps.focusMode, pref);
  if (focusMode) advanced.focusMode = focusMode;
  if (caps.pointsOfInterest) {
    advanced.pointsOfInterest = [{ x: clamp01(point.x), y: clamp01(point.y) }];
  }
  if (caps.focusDistance) {
    advanced.focusDistance = pickCloseFocusDistance(caps.focusDistance);
  }
  const zoom = caps.zoom ? pickQrZoom(caps.zoom) : null;
  if (zoom != null) advanced.zoom = zoom;
  return Object.keys(advanced).length ? advanced : null;
}

/** Progressive constraint sets: full request first, then drop keys that often Overconstrain. */
export function qrFocusConstraintFallbacks(
  caps: QrTrackCapabilities,
  point: FocusPoint = { x: 0.5, y: 0.5 },
  pref: FocusModePref = "auto",
): MediaTrackConstraints[] {
  const full = qrFocusAdvanced(caps, point, pref);
  if (!full) return [];

  const variants: Record<string, unknown>[] = [full];
  if ("focusDistance" in full) {
    const { focusDistance: _drop, ...rest } = full;
    if (Object.keys(rest).length) variants.push(rest);
  }
  if ("zoom" in full) {
    const stripped = { ...full };
    delete stripped.zoom;
    delete stripped.focusDistance;
    if (Object.keys(stripped).length) variants.push(stripped);
  }
  if (typeof full.focusMode === "string") {
    variants.push({ focusMode: full.focusMode });
  }

  const seen = new Set<string>();
  const out: MediaTrackConstraints[] = [];
  for (const item of variants) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ advanced: [item] } as MediaTrackConstraints);
  }
  return out;
}

export function tapPointFromEvent(
  clientX: number,
  clientY: number,
  rect: { left: number; width: number; top: number; height: number },
): FocusPoint {
  const x = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
  const y = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
  return { x: clamp01(x), y: clamp01(y) };
}

export async function applyFirstSupportedConstraint(
  track: { applyConstraints(constraints: MediaTrackConstraints): Promise<void> },
  chain: MediaTrackConstraints[],
): Promise<boolean> {
  for (const constraints of chain) {
    try {
      await track.applyConstraints(constraints);
      return true;
    } catch {
      /* device rejected this combination — try a simpler one */
    }
  }
  return false;
}
