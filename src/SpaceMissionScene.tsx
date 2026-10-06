import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Html, Line, OrbitControls, Stars, useTexture } from '@react-three/drei'
import * as THREE from 'three'

type Spacecraft = {
  id: string
  latitude: number
  longitude: number
  altitude_km: number
  health_state: string
  communication: string
  security: string
  ground_station: { id: string; visible: boolean }
}

type GroundStation = {
  id: string
  location: string
  latitude: number
  longitude: number
  state: string
}

type Props = {
  fleet: Spacecraft[]
  groundStations: GroundStation[]
  socketConnected: boolean
  onSelectSpacecraft: (id: string) => void
}

const earthRadius = 1.55
const toPosition = (latitude: number, longitude: number, radius: number) => {
  const lat = THREE.MathUtils.degToRad(latitude)
  const lon = THREE.MathUtils.degToRad(longitude)
  return new THREE.Vector3(
    radius * Math.cos(lat) * Math.sin(lon),
    radius * Math.sin(lat),
    radius * Math.cos(lat) * Math.cos(lon),
  )
}

const cityClusters = [
  [40, -100], [51, 10], [28, 78], [35, 105], [36, 138], [-15, -48],
  [30, 31], [24, 54], [1, 103], [-26, 28], [37, -4], [55, 37],
]

function createCityGeometry() {
  const points: number[] = []
  let seed = 314159
  const random = () => {
    seed = (seed * 16807) % 2147483647
    return (seed - 1) / 2147483646
  }

  for (const [latitude, longitude] of cityClusters) {
    for (let index = 0; index < 40; index += 1) {
      const point = toPosition(
        latitude + (random() - 0.5) * 12,
        longitude + (random() - 0.5) * 18,
        earthRadius * 1.004,
      )
      points.push(point.x, point.y, point.z)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
  return geometry
}

function Earth() {
  const clouds = useRef<THREE.Mesh>(null)
  const sourceMap = useTexture('/earth-blue-marble.jpg')
  const earthMap = useMemo(() => {
    const texture = sourceMap.clone()
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 8
    texture.needsUpdate = true
    return texture
  }, [sourceMap])
  const cities = useMemo(() => createCityGeometry(), [])
  const cityMaterial = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { sunDirection: { value: new THREE.Vector3(-4, 1.6, 5).normalize() } },
    vertexShader: `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(mat3(modelMatrix) * normalize(position));
        gl_PointSize = 2.2;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 sunDirection;
      varying vec3 vNormal;
      void main() {
        float night = 1.0 - smoothstep(-0.22, 0.12, dot(normalize(vNormal), normalize(sunDirection)));
        float point = 1.0 - smoothstep(0.18, 0.5, length(gl_PointCoord - 0.5));
        gl_FragColor = vec4(vec3(1.0, 0.72, 0.34), point * night * 0.78);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }), [])

  useFrame((_, delta) => {
    if (clouds.current) clouds.current.rotation.y += delta * 0.001
  })

  return (
    <>
      <mesh>
        <sphereGeometry args={[earthRadius, 96, 64]} />
        <meshPhongMaterial map={earthMap} color="#f4fbff" emissive="#203e59" emissiveIntensity={0.2} specular="#071b2d" shininess={1} />
      </mesh>
      <points geometry={cities} material={cityMaterial} />
      <mesh ref={clouds} scale={1.008}>
        <sphereGeometry args={[earthRadius, 64, 48]} />
        <shaderMaterial
          transparent
          depthWrite={false}
          uniforms={{ uTime: { value: 0 } }}
          vertexShader="varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }"
          fragmentShader={`
            varying vec2 vUv;
            uniform float uTime;
            void main(){
              vec2 p = vUv * vec2(38.0, 19.0) + vec2(uTime * 0.012, 0.0);
              float n = sin(p.x + sin(p.y * 1.7)) * cos(p.y + sin(p.x * 0.8));
              float cloud = smoothstep(0.53, 0.88, n);
              gl_FragColor = vec4(0.72, 0.86, 1.0, cloud * 0.065);
            }
          `}
        />
      </mesh>
      <mesh scale={1.055}>
        <sphereGeometry args={[earthRadius, 64, 48]} />
        <shaderMaterial
          transparent
          depthWrite={false}
          side={THREE.BackSide}
          blending={THREE.AdditiveBlending}
          vertexShader={`
            varying vec3 vNormal;
            varying vec3 vViewDirection;
            void main(){
              vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
              vNormal = normalize(normalMatrix * normal);
              vViewDirection = normalize(-viewPosition.xyz);
              gl_Position = projectionMatrix * viewPosition;
            }
          `}
          fragmentShader={`
            varying vec3 vNormal;
            varying vec3 vViewDirection;
            void main(){
              float rim = pow(1.0 - max(dot(normalize(vNormal), normalize(vViewDirection)), 0.0), 3.2);
              gl_FragColor = vec4(0.24, 0.7, 1.0, rim * 0.42);
            }
          `}
        />
      </mesh>
    </>
  )
}

function SatelliteModel({ color, selected, label, onClick }: { color: string; selected: boolean; label: string; onClick: () => void }) {
  const model = useRef<THREE.Group>(null)
  const pulse = useRef<THREE.Mesh>(null)
  useFrame(({ clock }, delta) => {
    if (model.current) {
      model.current.rotation.y += 0.22 * delta
      model.current.rotation.x += 0.045 * delta
    }
    if (pulse.current) {
      const scale = 1 + (Math.sin(clock.elapsedTime * 2.2) + 1) * 0.12
      pulse.current.scale.setScalar(scale)
    }
  })

  return (
    <group ref={model} rotation={[0.3, 0.25, -0.4]}>
      <mesh castShadow>
        <boxGeometry args={[0.105, 0.12, 0.1]} />
        <meshStandardMaterial color="#bccbd7" metalness={0.78} roughness={0.3} />
      </mesh>
      {[-1, 1].map((side) => (
        <group key={side} position={[side * 0.19, 0, 0]}>
          <mesh>
            <boxGeometry args={[0.27, 0.12, 0.012]} />
            <meshStandardMaterial color="#164d7d" metalness={0.45} roughness={0.4} emissive="#07213c" />
          </mesh>
          {[-0.07, 0, 0.07].map((x) => <mesh key={x} position={[x, 0, 0.008]}><boxGeometry args={[0.003, 0.115, 0.002]} /><meshBasicMaterial color="#64baff" /></mesh>)}
        </group>
      ))}
      <mesh position={[0.01, 0.015, 0.075]} rotation={[0.25, 0, 0]}>
        <coneGeometry args={[0.06, 0.045, 20, 1, true]} />
        <meshStandardMaterial color="#dce7ee" metalness={0.65} roughness={0.3} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, -0.09, 0]}><cylinderGeometry args={[0.003, 0.003, 0.09, 6]} /><meshStandardMaterial color="#dce7ee" /></mesh>
      <mesh position={[0.055, 0.055, 0.055]}>
        <sphereGeometry args={[0.012, 8, 8]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={2.5} />
      </mesh>
      <mesh ref={pulse}>
        <torusGeometry args={[0.105, 0.0025, 5, 32]} />
        <meshBasicMaterial color={color} transparent opacity={selected ? 0.45 : 0.25} />
      </mesh>
      <Html distanceFactor={8} position={[0.32, 0.03, 0]} center>
        <button onClick={(event) => { event.stopPropagation(); onClick() }} className="space-scene-label" aria-label={`Open ${label} mission workspace`}>{label}</button>
      </Html>
    </group>
  )
}

function CommunicationLink({ start, end, color }: { start: THREE.Vector3; end: THREE.Vector3; color: string }) {
  return (
    <Line points={[start, end]} color={color} lineWidth={0.7} transparent opacity={0.18} dashed dashScale={4} dashSize={0.08} gapSize={0.09} />
  )
}

type MissionGlobeProps = Omit<Props, 'socketConnected'> & { onStationSelect: (station: GroundStation) => void }

function MissionGlobe({ fleet, groundStations, onSelectSpacecraft, onStationSelect }: MissionGlobeProps) {
  const globe = useRef<THREE.Group>(null)
  useFrame((_, delta) => {
    if (globe.current) globe.current.rotation.y += delta * 0.012
  })
  const orbits = useMemo(() => [0, 1].map((orbit) => {
    const angle = orbit * 0.82 + 0.35
    const inclination = orbit === 0 ? 0.48 : -0.62
    return Array.from({ length: 144 }, (_, index) => {
      const theta = (index / 143) * Math.PI * 2
      return new THREE.Vector3(
        2.15 * Math.cos(theta) * Math.cos(angle),
        2.15 * Math.sin(theta) * Math.sin(inclination),
        2.15 * Math.cos(theta) * Math.sin(angle),
      )
    })
  }), [])
  const activeFleet = fleet.slice(0, 2)
  const chosenStation = activeFleet[0]?.ground_station
  const station = groundStations.find((item) => item.id === chosenStation?.id)
  const stationPosition = station ? toPosition(station.latitude, station.longitude, earthRadius * 1.015) : null

  return (
    <>
      <group ref={globe}>
        <Earth />
        {orbits.map((points, index) => <Line key={index} points={points} color={index === 0 ? '#4ba8dd' : '#56749b'} lineWidth={0.7} transparent opacity={0.26} />)}
        {activeFleet.map((asset, index) => {
        const direction = toPosition(asset.latitude, asset.longitude, 1).normalize()
        const position = direction.clone().multiplyScalar(earthRadius * (1 + asset.altitude_km / 6371))
        const securityAlert = asset.security.includes('POTENTIAL')
        const color = securityAlert ? '#f59e0b' : asset.communication !== 'CONNECTED' ? '#ef4444' : asset.health_state === 'NOMINAL' ? '#34d399' : '#f59e0b'
        const isConnected = asset.communication === 'CONNECTED' && asset.ground_station.visible
        return (
          <group key={asset.id} position={position.toArray()}>
            <SatelliteModel color={color} selected={index === 0} label={asset.id} onClick={() => onSelectSpacecraft(asset.id)} />
            {index === 0 && stationPosition && isConnected && <CommunicationLink start={new THREE.Vector3(0, 0, 0)} end={stationPosition.clone().sub(position)} color={color} />}
          </group>
        )
        })}
        {station && stationPosition && (
          <group position={stationPosition.toArray()}>
            <mesh>
              <sphereGeometry args={[0.027, 12, 12]} />
              <meshBasicMaterial color={station.state === 'ONLINE' ? '#4ade80' : '#f59e0b'} />
            </mesh>
            <Html distanceFactor={8} position={[0.08, 0.05, 0]} center>
              <button onClick={(event) => { event.stopPropagation(); onStationSelect(station) }} className="space-scene-label" aria-label={`Show ${station.id} ground station information`}>{station.id}</button>
            </Html>
          </group>
        )}
      </group>
      <OrbitControls makeDefault enablePan={false} minDistance={4.2} maxDistance={8.2} rotateSpeed={0.45} zoomSpeed={0.55} />
    </>
  )
}

function MissionClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let frame = 0
    let lastUpdate = 0
    const tick = (timestamp: number) => {
      if (timestamp - lastUpdate >= 40) {
        setNow(new Date())
        lastUpdate = timestamp
      }
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [])
  return <>{now.toISOString().slice(11, 23)} UTC</>
}

export default function SpaceMissionScene({ fleet, groundStations, socketConnected, onSelectSpacecraft }: Props) {
  const [resetKey, setResetKey] = useState(0)
  const [stationInfo, setStationInfo] = useState<GroundStation | null>(null)
  const [earthCursor, setEarthCursor] = useState({ x: 0, y: 0, active: false, dragging: false })
  const selected = fleet.find((asset) => asset.id === 'ORBIT-X1') ?? fleet[0]
  const connected = fleet.filter((asset) => asset.communication === 'CONNECTED').length
  const hasSecurityAlert = fleet.some((asset) => asset.security.includes('POTENTIAL'))

  return (
    <section
      id="home"
      className="space-mission-scene relative h-[calc(100svh-61px)] overflow-hidden border-b border-sky-300/10 bg-[#020712]"
      aria-label="Simulated three-dimensional mission overview"
      onPointerMove={(event) => {
        if (!(event.target instanceof HTMLCanvasElement)) {
          setEarthCursor((current) => current.active ? { ...current, active: false } : current)
          return
        }
        const bounds = event.currentTarget.getBoundingClientRect()
        setEarthCursor((current) => ({ ...current, x: event.clientX - bounds.left, y: event.clientY - bounds.top, active: true }))
      }}
      onPointerDown={(event) => {
        if (event.target instanceof HTMLCanvasElement) setEarthCursor((current) => ({ ...current, dragging: true }))
      }}
      onPointerUp={() => setEarthCursor((current) => ({ ...current, dragging: false }))}
      onPointerLeave={() => setEarthCursor((current) => ({ ...current, active: false, dragging: false }))}
    >
      <Canvas key={resetKey} dpr={[1, 1.5]} camera={{ position: [0, 0, 5.7], fov: 42 }} gl={{ antialias: true, powerPreference: 'high-performance' }}>
        <color attach="background" args={['#020712']} />
        <ambientLight intensity={0.9} color="#b6d7ff" />
        <directionalLight position={[-4, 2.5, 5]} intensity={2.1} color="#fff0d8" />
        <pointLight position={[4, -2, -4]} intensity={0.45} color="#164c9a" />
        <Stars radius={70} depth={45} count={1900} factor={3.2} saturation={0} fade speed={0.02} />
        <Suspense fallback={null}>
          <MissionGlobe fleet={fleet} groundStations={groundStations} onSelectSpacecraft={onSelectSpacecraft} onStationSelect={setStationInfo} />
        </Suspense>
      </Canvas>
      {earthCursor.active && <div className="earth-cursor" style={{ left: earthCursor.x, top: earthCursor.y }} aria-hidden="true">
        <span className={earthCursor.dragging ? 'earth-cursor-reticle is-dragging' : 'earth-cursor-reticle'} />
        <span className="earth-cursor-label">{earthCursor.dragging ? 'ROTATING EARTH' : 'DRAG TO ROTATE'}</span>
      </div>}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_35%,rgba(2,7,18,0.22)_75%,rgba(2,7,18,0.68)_100%)]" />
      <div className="absolute left-5 top-5 z-10 max-w-[min(40vw,440px)] sm:left-8 sm:top-7">
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-300/25 bg-emerald-300/[.07] px-3 py-1.5 text-[9px] font-bold uppercase tracking-[.19em] text-emerald-100">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" /> Simulated live mission
        </div>
        <h1 className="mt-4 text-xl font-semibold tracking-[.12em] text-white sm:text-3xl">MISSION OPERATIONS</h1>
        <p className="mt-1 text-[10px] tracking-wide text-slate-300 sm:text-xs">Evidence-Grounded Spacecraft Decision Support</p>
      </div>
      <div className="absolute right-4 top-[108px] z-10 w-[min(220px,44vw)] text-right sm:right-8 sm:top-7 sm:w-auto">
        <div className="text-[8px] font-semibold uppercase tracking-[.2em] text-slate-400">Mission time</div>
        <div className="mt-1 font-mono text-xs font-semibold tabular-nums text-sky-100 sm:text-sm"><MissionClock /></div>
        <div className="mt-2 text-[8px] font-semibold uppercase tracking-[.16em] text-emerald-200">{connected}/{fleet.length || 2} simulated links connected</div>
      </div>
      <div className="absolute bottom-5 left-4 right-4 z-10 flex max-w-full flex-wrap justify-between gap-2 sm:bottom-7 sm:left-8 sm:right-auto sm:max-w-[min(70vw,460px)]">
        {fleet.slice(0, 2).map((asset) => {
          const active = asset.id === selected?.id
          const stateColor = asset.security.includes('POTENTIAL') ? 'text-amber-300' : asset.communication !== 'CONNECTED' ? 'text-red-300' : asset.health_state === 'NOMINAL' ? 'text-emerald-300' : 'text-amber-300'
          return (
            <button key={asset.id} onClick={() => onSelectSpacecraft(asset.id)} className={`rounded-xl border px-3 py-2 text-left backdrop-blur-md transition hover:border-sky-300/50 ${active ? 'border-sky-300/35 bg-sky-950/60' : 'border-white/10 bg-slate-950/65'}`} aria-label={`Open ${asset.id} mission workspace`}>
              <span className="block text-[9px] font-bold tracking-widest text-white">{asset.id}</span>
              <span className={`mt-1 block text-[8px] font-semibold uppercase tracking-wider ${stateColor}`}>● {asset.health_state} · {asset.communication}</span>
              <span className="mt-1 block text-[8px] text-slate-400">{asset.altitude_km.toFixed(0)} km · {asset.latitude.toFixed(1)}°, {asset.longitude.toFixed(1)}°</span>
            </button>
          )
        })}
        <button onClick={() => setResetKey((value) => value + 1)} className="self-center rounded-lg border border-white/15 bg-slate-950/65 px-3 py-2 text-[8px] font-bold uppercase tracking-widest text-slate-300 backdrop-blur hover:text-white">Reset view</button>
      </div>
      <div className="absolute bottom-5 right-5 z-10 w-[min(250px,44vw)] rounded-xl border border-white/10 bg-slate-950/65 p-3 backdrop-blur-md sm:bottom-7 sm:right-8 sm:w-60 sm:p-4">
        <div className="text-[8px] font-bold uppercase tracking-[.2em] text-slate-400">Mission status · backend</div>
        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[9px]">
          <span className="text-slate-500">Selected</span><span className="text-right font-semibold text-white">{selected?.id ?? 'Connecting'}</span>
          <span className="text-slate-500">Telemetry</span><span className={`text-right font-semibold ${socketConnected ? 'text-emerald-300' : 'text-amber-300'}`}>{socketConnected ? 'SIMULATED LIVE' : 'RECONNECTING'}</span>
          <span className="text-slate-500">Communication</span><span className={`text-right font-semibold ${selected?.communication === 'CONNECTED' ? 'text-emerald-300' : 'text-red-300'}`}>{selected?.communication ?? 'UNKNOWN'}</span>
          <span className="text-slate-500">Security</span><span className={`text-right font-semibold ${hasSecurityAlert ? 'text-amber-300' : 'text-sky-200'}`}>{hasSecurityAlert ? 'ALERT · UNCONFIRMED' : 'SIMULATED CHECKS'}</span>
        </div>
        <div className="mt-3 border-t border-white/10 pt-2 text-[8px] leading-4 text-slate-500">Drag to rotate · scroll to zoom · Earth view is a simulation</div>
      </div>
      {stationInfo && <div role="dialog" aria-label="Ground station details" className="absolute left-1/2 top-1/2 z-20 w-[min(300px,85vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-sky-300/25 bg-[#07111F]/95 p-4 shadow-2xl backdrop-blur-xl">
        <div className="flex items-start justify-between gap-3"><div><div className="text-[8px] font-bold uppercase tracking-[.2em] text-sky-300">Ground station</div><h2 className="mt-1 text-sm font-semibold text-white">{stationInfo.id} · {stationInfo.location}</h2></div><button onClick={() => setStationInfo(null)} className="text-xs text-slate-400 hover:text-white" aria-label="Close ground station details">×</button></div>
        <p className="mt-3 text-[10px] leading-5 text-slate-300">Simulated station at {stationInfo.latitude.toFixed(1)}°, {stationInfo.longitude.toFixed(1)}°. Current state: <strong className={stationInfo.state === 'ONLINE' ? 'text-emerald-300' : 'text-amber-300'}>{stationInfo.state}</strong>.</p>
      </div>}
    </section>
  )
}
