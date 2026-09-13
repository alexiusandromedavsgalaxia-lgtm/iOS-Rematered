// Shared hardware model. Kept independent from HardwareBus to avoid ESM circular dependencies.

export const DEVICE_MODEL = Object.freeze({
  name: 'iPhone 16 Pro',
  soc: {
    name: 'Apple A18 Pro',
    cpu: { cores: 6, config: '2P + 4E', maxClockGHz: 4.05 },
    gpu: { cores: 6, name: 'Apple GPU Gen 6', family: 'Apple GPU Gen 6', tflops: 2.15 },
    ane: { cores: 16, tops: 35 },
  },
  cpu: { cores: 6, config: '2P + 4E', maxClockGHz: 4.05 },
  gpu: { cores: 6, family: 'Apple GPU Gen 6', name: 'Apple GPU Gen 6', tflops: 2.15 },
  ane: { cores: 16, tops: 35 },
  ram: { sizeGB: 8, type: 'LPDDR5X' },
  storage: {
    sizeGB: 256,
    sizeBytes: 256 * 1024 * 1024 * 1024,
    type: 'NVMe',
    filesystem: 'APFS',
  },
  display: {
    sizeInches: 6.3,
    type: 'Super Retina XDR OLED',
    refreshHz: 120,
    resolution: '2622x1206',
    width: 1206,
    height: 2622,
    brightnessNits: 2000,
  },
  cameras: [
    { id: 'wide', name: 'Wide', megapixels: 48, focalLengthMm: 24, aperture: 1.78 },
    { id: 'ultrawide', name: 'Ultrawide', megapixels: 48, focalLengthMm: 13, aperture: 2.2 },
    { id: 'tele', name: 'Telephoto', megapixels: 12, focalLengthMm: 120, aperture: 2.8, opticalZoom: 5 },
    { id: 'front', name: 'TrueDepth', megapixels: 12, focalLengthMm: 23, aperture: 1.9 },
  ],
  sensors: {
    accelerometer: { id: 'accel', name: 'Accelerometer' },
    gyroscope: { id: 'gyro', name: 'Gyroscope' },
    magnetometer: { id: 'mag', name: 'Magnetometer' },
    barometer: { id: 'baro', name: 'Barometer' },
    ambientLight: { id: 'als', name: 'Ambient Light Sensor' },
    proximity: { id: 'prox', name: 'Proximity Sensor' },
    lidar: { id: 'lidar', name: 'LiDAR' },
  },
  radios: {
    wifi: { name: 'Wi‑Fi 7', mimo: 2, maxSpeedGbps: 5.8 },
    bluetooth: { name: 'Bluetooth 5.3', version: '5.3' },
    cellular: {
      name: '5G NR',
      bands5G: ['n1','n2','n3','n5','n7','n8','n12','n14','n20','n25','n26','n28','n29','n30','n38','n40','n41','n48','n66','n71','n77','n78'],
    },
    gps: { name: 'GNSS', systems: ['GPS', 'GLONASS', 'Galileo', 'BeiDou', 'QZSS'] },
  },
  security: ['Secure Enclave', 'Face ID', 'Touch ID (n/a)'],
  battery: {
    mAh: 3582,
    capacityMah: 3582,
    chemistry: 'Li-Ion',
    voltage: 3.87,
    wh: 13.86,
    energyWh: 13.86,
  },
});

export default DEVICE_MODEL;
