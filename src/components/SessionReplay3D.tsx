import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { RecallTimelineMoment } from "../types/recall";
import { findAbletonInstrumentReference } from "../utils/abletonInstruments";

type SessionReplay3DProps = {
  events: RecallTimelineMoment[];
  selectedEventId?: string | null;
  onSelectEvent: (eventId: string) => void;
};

type ReplayNode = {
  event: RecallTimelineMoment;
  lane: string;
  laneIndex: number;
  timeRatio: number;
};

const EVENT_COLORS: Record<string, number> = {
  track: 0x46b7ff,
  device: 0xff6fae,
  parameter: 0xf3cf4d,
  transport: 0x6b8cff,
  tempo: 0xffb35c,
  clip: 0xb993ff,
  session: 0xff8a5b,
  file: 0xff8a5b,
  creative_moment: 0x9ed7ff,
  unknown: 0x9aa5b1,
};

const MAX_RENDERED_NODES = 180;

export function SessionReplay3D({
  events,
  selectedEventId,
  onSelectEvent,
}: SessionReplay3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const onSelectEventRef = useRef(onSelectEvent);
  const selectedEventIdRef = useRef(selectedEventId);
  const nodesRef = useRef<ReplayNode[]>([]);
  const eventsRef = useRef(events);
  const sceneDataRef = useRef(buildReplayNodes(events));
  const rebuildSceneRef = useRef<(() => void) | null>(null);
  const resetCameraRef = useRef<(() => void) | null>(null);
  const scanPausedRef = useRef(false);
  const meshEventIdsRef = useRef(new Map<string, string>());
  const [inspectedEvent, setInspectedEvent] =
    useState<RecallTimelineMoment | null>(null);
  const inspectedInstrument = findAbletonInstrumentReference(
    inspectedEvent?.deviceName ?? String(inspectedEvent?.metadata?.device ?? ""),
  );
  const [scanPaused, setScanPaused] = useState(false);

  const sceneData = useMemo(() => buildReplayNodes(events), [events]);

  useEffect(() => {
    onSelectEventRef.current = onSelectEvent;
  }, [onSelectEvent]);

  useEffect(() => {
    selectedEventIdRef.current = selectedEventId;
    const selected = events.find((event) => event.id === selectedEventId);
    setInspectedEvent(selected ?? null);
  }, [events, selectedEventId]);

  useEffect(() => {
    scanPausedRef.current = scanPaused;
  }, [scanPaused]);

  useEffect(() => {
    nodesRef.current = sceneData.nodes;
    eventsRef.current = events;
    sceneDataRef.current = sceneData;
    rebuildSceneRef.current?.();
  }, [sceneData.nodes]);

  useEffect(() => {
    const mount = mountRef.current;

    if (!mount) {
      return;
    }

    const mountElement = mount;

    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    renderer.setClearColor(0x000000, 0);
    mountElement.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x070a10, 28, 86);

    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 120);
    camera.position.set(0, 14, 31);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true;
    controls.minDistance = 18;
    controls.maxDistance = 55;
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.target.set(0, 0, 0);

    function resetCamera() {
      camera.position.set(0, 14, 31);
      controls.target.set(0, 0, 0);
      controls.update();
    }

    const ambient = new THREE.AmbientLight(0x9fb7c9, 0.55);
    scene.add(ambient);

    const keyLight = new THREE.PointLight(0x46b7ff, 1.15, 70);
    keyLight.position.set(-18, 18, 18);
    scene.add(keyLight);

    const magentaLight = new THREE.PointLight(0xff6fae, 0.65, 60);
    magentaLight.position.set(22, 10, -14);
    scene.add(magentaLight);

    const grid = new THREE.GridHelper(52, 26, 0x263b57, 0x17212d);
    grid.position.y = -1.05;
    scene.add(grid);

    const scanMaterial = new THREE.MeshBasicMaterial({
      color: 0x46b7ff,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
    });
    const scanPlane = new THREE.Mesh(
      new THREE.BoxGeometry(0.055, 0.08, 17),
      scanMaterial,
    );
    scanPlane.position.y = -0.62;
    scene.add(scanPlane);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const replayRoot = new THREE.Group();
    scene.add(replayRoot);
    let isVisible = true;
    let isDocumentVisible = !document.hidden;

    const resizeObserver = new ResizeObserver(resize);
    const visibilityObserver = new IntersectionObserver(([entry]) => {
      isVisible = entry?.isIntersecting ?? true;
    });

    function resize() {
      const width = mountElement.clientWidth;
      const height = mountElement.clientHeight;

      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    }

    function rebuild() {
      disposeGroup(replayRoot);
      replayRoot.clear();
      meshEventIdsRef.current.clear();
      const currentSceneData = sceneDataRef.current;

      const laneMaterial = new THREE.MeshBasicMaterial({
        color: 0x2d435f,
        transparent: true,
        opacity: 0.46,
      });
      const laneGeometry = new THREE.BoxGeometry(42, 0.045, 0.12);

      currentSceneData.lanes.forEach((_, laneIndex) => {
        const z = laneZ(laneIndex, currentSceneData.lanes.length);
        const laneMesh = new THREE.Mesh(laneGeometry, laneMaterial);
        laneMesh.position.set(0, -0.72, z);
        replayRoot.add(laneMesh);

        const railMaterial = new THREE.MeshBasicMaterial({
          color: laneIndex % 2 === 0 ? 0x46b7ff : 0xff6fae,
          transparent: true,
          opacity: 0.22,
        });
        const rail = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.075, 0.2), railMaterial);
        rail.position.set(-21.5, -0.62, z);
        replayRoot.add(rail);
      });

      currentSceneData.nodes.slice(-MAX_RENDERED_NODES).forEach((node) => {
        const color = EVENT_COLORS[node.event.type] ?? EVENT_COLORS.unknown;
        const radius = node.event.type === "track" ? 0.42 : 0.32;
        const geometry =
          node.event.type === "parameter"
            ? new THREE.OctahedronGeometry(radius, 0)
            : new THREE.SphereGeometry(radius, 24, 16);
        const material = new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: node.event.id === selectedEventIdRef.current ? 0.85 : 0.42,
          roughness: 0.35,
          metalness: 0.32,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(
          nodeX(node.timeRatio),
          nodeY(node.event.type),
          laneZ(node.laneIndex, currentSceneData.lanes.length),
        );
        mesh.userData.eventId = node.event.id;
        meshEventIdsRef.current.set(mesh.uuid, node.event.id);
        replayRoot.add(mesh);

        const stemMaterial = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.28,
        });
        const stemHeight = Math.max(0.2, mesh.position.y + 0.8);
        const stem = new THREE.Mesh(new THREE.BoxGeometry(0.035, stemHeight, 0.035), stemMaterial);
        stem.position.set(mesh.position.x, -0.8 + stemHeight / 2, mesh.position.z);
        replayRoot.add(stem);
      });

      const playheadMaterial = new THREE.MeshBasicMaterial({
        color: 0x9ed7ff,
        transparent: true,
        opacity: 0.7,
      });
      const playhead = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.12, 17),
        playheadMaterial,
      );
      const selectedNode = currentSceneData.nodes.find(
        (node) => node.event.id === selectedEventIdRef.current,
      );
      playhead.position.set(selectedNode ? nodeX(selectedNode.timeRatio) : -21, -0.5, 0);
      replayRoot.add(playhead);
    }

    function handlePointerDown(event: PointerEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      const hits = raycaster.intersectObjects(replayRoot.children, false);
      const hit = hits.find((candidate: THREE.Intersection) =>
        meshEventIdsRef.current.has(candidate.object.uuid),
      );

      if (!hit) {
        return;
      }

      const eventId = meshEventIdsRef.current.get(hit.object.uuid);
      const replayEvent = eventsRef.current.find((item) => item.id === eventId);

      if (eventId && replayEvent) {
        selectedEventIdRef.current = eventId;
        setInspectedEvent(replayEvent);
        onSelectEventRef.current(eventId);
        rebuild();
      }
    }

    let animationFrame = 0;
    let lastTime = 0;

    function animate(time: number) {
      const elapsed = time * 0.001;

      if (!isVisible || !isDocumentVisible) {
        animationFrame = window.requestAnimationFrame(animate);
        return;
      }

      controls.update();
      if (!scanPausedRef.current) {
        scanPlane.position.x = -22 + ((elapsed * 5.5) % 44);
        keyLight.intensity = 1.05 + Math.sin(elapsed * 1.7) * 0.12;
      }

      if (time - lastTime > 80) {
        replayRoot.children.forEach((child: THREE.Object3D) => {
          const eventId = child.userData.eventId as string | undefined;

          if (!eventId) {
            return;
          }

          child.position.y += Math.sin(elapsed * 2.2 + child.position.x) * 0.0009;
        });
        lastTime = time;
      }

      renderer.render(scene, camera);
      animationFrame = window.requestAnimationFrame(animate);
    }

    resize();
    rebuild();
    rebuildSceneRef.current = rebuild;
    resetCameraRef.current = resetCamera;
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    resizeObserver.observe(mountElement);
    visibilityObserver.observe(mountElement);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    animationFrame = window.requestAnimationFrame(animate);

    function handleVisibilityChange() {
      isDocumentVisible = !document.hidden;
    }

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      controls.dispose();
      disposeGroup(replayRoot);
      renderer.dispose();
      rebuildSceneRef.current = null;
      resetCameraRef.current = null;

      if (mountElement.contains(renderer.domElement)) {
        mountElement.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div className="replay3d-shell">
      <div className="replay3d-stage" ref={mountRef} />

      <div className="replay3d-hud">
        <div>
          <span>Recall Matrix</span>
          <strong>{sceneData.lanes.length} lanes</strong>
        </div>

        <div>
          <span>Nodes</span>
          <strong>{sceneData.nodes.length}</strong>
        </div>
      </div>

      <div className="replay3d-controls">
        <button type="button" onClick={() => setScanPaused((value) => !value)}>
          {scanPaused ? "Resume Scan" : "Pause Scan"}
        </button>
        <button type="button" onClick={() => resetCameraRef.current?.()}>
          Reset View
        </button>
      </div>

      <div className="replay3d-lanes">
        {sceneData.lanes.slice(0, 8).map((lane) => (
          <span key={lane}>{lane}</span>
        ))}
      </div>

      {inspectedEvent && (
        <div className="replay3d-inspector">
          <button type="button" onClick={() => onSelectEvent(inspectedEvent.id)}>
            <span>{inspectedEvent.sessionTimecode}</span>
            <strong>{inspectedEvent.summary}</strong>
          </button>

          {inspectedInstrument && (
            <div className="replay3d-instrument">
              <span>{inspectedInstrument.family}</span>
              <strong>{inspectedInstrument.name}</strong>
              <p>{inspectedInstrument.role}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function buildReplayNodes(events: RecallTimelineMoment[]): {
  lanes: string[];
  nodes: ReplayNode[];
} {
  const creativeEvents = events.filter((event) => event.type !== "heartbeat");
  const lanes = Array.from(
    new Set(
      creativeEvents.map((event) => readLaneName(event)).filter(Boolean),
    ),
  );

  if (lanes.length === 0) {
    lanes.push("Session");
  }

  const minTime = Math.min(...creativeEvents.map((event) => event.timestamp), Date.now());
  const maxTime = Math.max(...creativeEvents.map((event) => event.timestamp), minTime + 1);

  const nodes = creativeEvents.map((event, index) => {
    const lane = readLaneName(event) || "Session";
    const laneIndex = Math.max(0, lanes.indexOf(lane));

    return {
      event,
      lane,
      laneIndex,
      timeRatio:
        creativeEvents.length <= 1
          ? index / Math.max(creativeEvents.length - 1, 1)
          : (event.timestamp - minTime) / Math.max(maxTime - minTime, 1),
    };
  });

  return { lanes, nodes };
}

function disposeGroup(group: THREE.Group) {
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }

    child.geometry.dispose();

    if (Array.isArray(child.material)) {
      child.material.forEach((material) => material.dispose());
      return;
    }

    child.material.dispose();
  });
}

function readLaneName(event: RecallTimelineMoment): string {
  const track = event.trackName ?? event.metadata?.track;

  if (typeof track === "string" && track.trim()) {
    return track;
  }

  if (event.type === "tempo" || event.type === "transport") {
    return "Transport";
  }

  if (event.type === "file" || event.type === "session") {
    return "Live Set";
  }

  return "Session";
}

function nodeX(timeRatio: number): number {
  return -20 + timeRatio * 40;
}

function laneZ(laneIndex: number, laneCount: number): number {
  const spacing = 2.2;
  return (laneIndex - (laneCount - 1) / 2) * spacing;
}

function nodeY(type: string): number {
  switch (type) {
    case "track":
      return 1.3;
    case "device":
      return 2.1;
    case "parameter":
      return 2.9;
    case "clip":
      return 1.7;
    case "tempo":
    case "transport":
      return 3.5;
    default:
      return 1.1;
  }
}
