import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { ProducerWorkKind } from "../../components/schema/timeline/producerWork";
import type { ReportTrack } from "./sessionReport";

type TrackConstellationProps = {
  tracks: ReportTrack[];
  onSelectTrack: (track: ReportTrack) => void;
};

type ConstellationNode = {
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  track: ReportTrack;
};

type OrbitPose = {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
};

const MAX_VISIBLE_TRACKS = 32;
const FEATURED_TETHER_COUNT = 12;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const WORK_COLORS: Record<ProducerWorkKind, number> = {
  writing: 0xa696ff,
  recording: 0x7aaaf7,
  sound: 0x76d6c9,
  arrangement: 0x91a7db,
  mixing: 0x5f8ff5,
  project: 0x9ca9bd,
  moment: 0xe2b960,
};

function trackActivity(track: ReportTrack): number {
  return track.sourceEventCount + track.actionCount;
}

function dominantTrackColor(track: ReportTrack): number {
  return WORK_COLORS[track.workKinds[0] ?? "project"];
}

function countLabel(value: number): string {
  return `${value.toLocaleString()} ${value === 1 ? "change" : "changes"}`;
}

/**
 * A small WebGL model of the active set. The inner sphere is the common
 * session, each outer node is a track, and the web joins their shared work.
 */
export function TrackConstellation({ tracks, onSelectTrack }: TrackConstellationProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const orbitPoseRef = useRef<OrbitPose>({ x: -0.15, y: 0.22, targetX: -0.15, targetY: 0.22 });
  const [hoveredTrack, setHoveredTrack] = useState<ReportTrack | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const selectTrack = useEffectEvent(onSelectTrack);
  const activeTrackCount = tracks.filter((track) => track.sourceEventCount > 0 || track.actionCount > 0).length;
  const activeTracks = useMemo(
    () => tracks
      .filter((track) => track.sourceEventCount > 0 || track.actionCount > 0)
      .sort((a, b) => trackActivity(b) - trackActivity(a) || a.name.localeCompare(b.name))
      .slice(0, MAX_VISIBLE_TRACKS),
    [tracks],
  );
  const fieldSignature = activeTracks
    .map((track) => `${track.id}:${track.sourceEventCount}:${track.actionCount}:${track.workKinds.join(",")}`)
    .join("|");

  useEffect(() => {
    setHoveredTrack(null);
    setUnavailable(false);
  }, [fieldSignature]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas || activeTracks.length === 0 || unavailable) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, canvas, powerPreference: "high-performance" });
    } catch {
      setUnavailable(true);
      return;
    }

    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    camera.position.set(0, 0, 8.5);

    const field = new THREE.Group();
    const savedPose = orbitPoseRef.current;
    field.rotation.set(savedPose.x, savedPose.y, 0);
    scene.add(field);

    const coreGeometry = new THREE.IcosahedronGeometry(1.16, 1);
    const coreMaterial = new THREE.MeshBasicMaterial({
      color: 0x4c6cbd,
      transparent: true,
      opacity: 0.14,
      wireframe: true,
    });
    const core = new THREE.Mesh(coreGeometry, coreMaterial);
    field.add(core);

    const ringGeometry = new THREE.TorusGeometry(1.55, 0.008, 5, 112);
    const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x8caaf6, transparent: true, opacity: 0.38 });
    const rings = new THREE.Group();
    [[0.35, 0.72, 0], [1.55, -0.24, 0.7], [-0.54, 0.12, 1.18]].forEach(([x, y, z]) => {
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.rotation.set(x, y, z);
      rings.add(ring);
    });
    field.add(rings);

    const nodeGeometry = new THREE.SphereGeometry(1, 14, 14);
    const materials = new Map<number, THREE.MeshBasicMaterial>();
    const materialFor = (color: number) => {
      const existing = materials.get(color);
      if (existing) return existing;
      const next = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
      materials.set(color, next);
      return next;
    };

    const activityCeiling = Math.max(1, ...activeTracks.map(trackActivity));
    const nodes: ConstellationNode[] = [];
    const strands: number[] = [];
    const addStrand = (from: THREE.Vector3, to: THREE.Vector3) => {
      strands.push(from.x, from.y, from.z, to.x, to.y, to.z);
    };

    activeTracks.forEach((track, index) => {
      const fraction = activeTracks.length === 1 ? 0.5 : index / (activeTracks.length - 1);
      const y = 1 - fraction * 2;
      const radius = Math.sqrt(Math.max(0, 1 - y * y));
      const angle = index * GOLDEN_ANGLE;
      const anchor = new THREE.Vector3(
        Math.cos(angle) * radius * 1.68,
        y * 1.68,
        Math.sin(angle) * radius * 1.08,
      );
      const intensity = Math.sqrt(trackActivity(track) / activityCeiling);
      const outer = anchor.clone().normalize().multiplyScalar(2.12 + intensity * 1.02);
      const node = new THREE.Mesh(nodeGeometry, materialFor(dominantTrackColor(track)));
      node.position.copy(outer);
      node.scale.setScalar(0.04 + intensity * 0.09);
      field.add(node);
      nodes.push({ mesh: node, track });
      // Only the leading activity nodes get a tether. Connecting every node
      // to every neighbour made a truthful field look like an unreadable knot.
      if (index < Math.min(FEATURED_TETHER_COUNT, activeTracks.length)) addStrand(anchor, outer);
    });

    const strandGeometry = new THREE.BufferGeometry();
    strandGeometry.setAttribute("position", new THREE.Float32BufferAttribute(strands, 3));
    const strandMaterial = new THREE.LineBasicMaterial({
      color: 0x9aaef0,
      transparent: true,
      opacity: 0.18,
    });
    field.add(new THREE.LineSegments(strandGeometry, strandMaterial));

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hoveredNode: ConstellationNode | null = null;
    let pressPoint: { x: number; y: number } | null = null;
    let dragging = false;
    let targetRotationX = savedPose.targetX;
    let targetRotationY = savedPose.targetY;
    let animationFrame = 0;
    let stopped = false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    const nodeAt = (event: PointerEvent): ConstellationNode | null => {
      const bounds = canvas.getBoundingClientRect();
      pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      scene.updateMatrixWorld();
      raycaster.setFromCamera(pointer, camera);
      const intersection = raycaster.intersectObjects(nodes.map((node) => node.mesh), false)[0];
      return intersection ? nodes.find((node) => node.mesh === intersection.object) ?? null : null;
    };

    const setHover = (next: ConstellationNode | null) => {
      if (hoveredNode?.mesh === next?.mesh) return;
      if (hoveredNode) hoveredNode.mesh.scale.multiplyScalar(1 / 1.65);
      hoveredNode = next;
      if (hoveredNode) hoveredNode.mesh.scale.multiplyScalar(1.65);
      canvas.style.cursor = hoveredNode ? "pointer" : "grab";
      setHoveredTrack(hoveredNode?.track ?? null);
    };

    const move = (event: PointerEvent) => {
      if (dragging) {
        targetRotationY += event.movementX * 0.008;
        targetRotationX = THREE.MathUtils.clamp(targetRotationX + event.movementY * 0.005, -0.72, 0.42);
        // Keep the field under the pointer while dragging; a low damping value
        // was visually smooth but felt delayed and made the orbit stutter.
        field.rotation.set(targetRotationX, targetRotationY, 0);
        return;
      }
      setHover(nodeAt(event));
    };
    const leave = () => setHover(null);
    const down = (event: PointerEvent) => {
      pressPoint = { x: event.clientX, y: event.clientY };
      dragging = true;
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = "grabbing";
    };
    const up = (event: PointerEvent) => {
      if (!pressPoint) return;
      const travelled = Math.hypot(event.clientX - pressPoint.x, event.clientY - pressPoint.y);
      pressPoint = null;
      dragging = false;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      const selected = nodeAt(event);
      canvas.style.cursor = selected ? "pointer" : "grab";
      if (travelled < 8 && selected) selectTrack(selected.track);
    };
    const cancel = (event: PointerEvent) => {
      pressPoint = null;
      dragging = false;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      canvas.style.cursor = hoveredNode ? "pointer" : "grab";
    };
    const contextLost = (event: Event) => {
      event.preventDefault();
      setUnavailable(true);
    };

    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
    canvas.addEventListener("webglcontextlost", contextLost);

    const draw = (time: number) => {
      if (stopped) return;
      field.rotation.y += (targetRotationY - field.rotation.y) * 0.12;
      field.rotation.x += (targetRotationX - field.rotation.x) * 0.12;
      orbitPoseRef.current = {
        x: field.rotation.x,
        y: field.rotation.y,
        targetX: targetRotationX,
        targetY: targetRotationY,
      };
      if (!reducedMotion) {
        core.rotation.y = time * 0.00017;
        rings.rotation.z = time * 0.00009;
        rings.rotation.y = Math.sin(time * 0.00011) * 0.11;
      }
      renderer.render(scene, camera);
      animationFrame = requestAnimationFrame(draw);
    };
    animationFrame = requestAnimationFrame(draw);

    return () => {
      stopped = true;
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("webglcontextlost", contextLost);
      coreGeometry.dispose();
      coreMaterial.dispose();
      ringGeometry.dispose();
      ringMaterial.dispose();
      nodeGeometry.dispose();
      strandGeometry.dispose();
      strandMaterial.dispose();
      materials.forEach((material) => material.dispose());
      renderer.dispose();
    };
  }, [fieldSignature, unavailable]);

  if (activeTracks.length === 0) {
    return <div className="track-constellation track-constellation--empty">Recall needs track activity before it can form a field.</div>;
  }

  return (
    <div className={`track-constellation ${unavailable ? "is-unavailable" : ""}`} ref={hostRef}>
      <canvas ref={canvasRef} aria-hidden="true" />
      <div className="track-constellation__hud" aria-hidden="true">
        <span>Track field</span>
        <span>{activeTracks.length === activeTrackCount ? `${activeTracks.length} active nodes` : `${activeTracks.length} priority nodes`}</span>
      </div>
      {unavailable ? (
        <div className="track-constellation__fallback">
          <span>Track field could not start</span>
          <button type="button" onClick={() => selectTrack(activeTracks[0]!)}>{activeTracks[0]!.name}</button>
        </div>
      ) : (
        <>
          <span className="track-constellation__hint">Drag to orbit. Select a node to inspect it.</span>
          {hoveredTrack && (
            <button
              type="button"
              className="track-constellation__readout"
              onClick={() => selectTrack(hoveredTrack)}
            >
              <span>{hoveredTrack.workLabel}</span>
              <strong>{hoveredTrack.name}</strong>
              <small>{countLabel(hoveredTrack.sourceEventCount)} captured</small>
            </button>
          )}
        </>
      )}
      <ol className="track-constellation__access-list" aria-label="Tracks in the session field">
        {activeTracks.map((track) => (
          <li key={track.id}>
            <button type="button" onClick={() => selectTrack(track)}>
              {track.name} - {countLabel(track.sourceEventCount)}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default TrackConstellation;
