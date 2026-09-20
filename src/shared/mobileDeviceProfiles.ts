/** Screen testing presets. Density is a test configuration, not factory panel PPI.
 * Galaxy profiles do not install Samsung firmware or One UI. Physical sizing
 * uses official body/rectangular-display millimetres, not rounded marketing inches.
 * Physical sources are recorded in DESIGN_MOBILE_PHYSICAL_CALIBRATION_2026-09-19.md.
 */
export const MOBILE_DEVICE_PROFILES = [
  {id:'native',name:'Tela original',platform:'android',brand:'Android',width:null,height:null,density:null,displayDiagonalInches:null,bodyWidthMm:null,bodyHeightMm:null,displayDiagonalMm:null,frame:'pixel',sourceUrl:'https://developer.android.com/studio/run/emulator-commandline'},
  {id:'pixel-7',name:'Pixel 7',platform:'android',brand:'Google',width:1080,height:2400,density:420,displayDiagonalInches:6.3,bodyWidthMm:73.2,bodyHeightMm:155.6,displayDiagonalMm:160.5,frame:'pixel',sourceUrl:'https://support.google.com/pixelphone/answer/7158570?hl=en'},
  {id:'pixel-9',name:'Pixel 9',platform:'android',brand:'Google',width:1080,height:2424,density:420,displayDiagonalInches:6.3,bodyWidthMm:72,bodyHeightMm:152.8,displayDiagonalMm:160,frame:'pixel',sourceUrl:'https://support.google.com/pixelphone/answer/7158570?hl=en'},
  {id:'galaxy-s24',name:'Galaxy S24',platform:'android',brand:'Samsung',width:1080,height:2340,density:420,displayDiagonalInches:6.2,bodyWidthMm:70.6,bodyHeightMm:147,displayDiagonalMm:156.4,frame:'galaxy',sourceUrl:'https://www.samsung.com/ae/support/mobile-devices/what-are-the-sizes-and-the-resolution-of-the-new-s24-series/'},
  {id:'galaxy-s24-ultra',name:'Galaxy S24 Ultra',platform:'android',brand:'Samsung',width:1440,height:3120,density:560,displayDiagonalInches:6.8,bodyWidthMm:79,bodyHeightMm:162.3,displayDiagonalMm:172.5,frame:'galaxy-ultra',sourceUrl:'https://www.samsung.com/ae/support/mobile-devices/what-are-the-sizes-and-the-resolution-of-the-new-s24-series/'},
  {id:'galaxy-a54',name:'Galaxy A54 5G',platform:'android',brand:'Samsung',width:1080,height:2340,density:420,displayDiagonalInches:6.4,bodyWidthMm:76.7,bodyHeightMm:158.2,displayDiagonalMm:163.1,frame:'galaxy',sourceUrl:'https://www.samsung.com/hk_en/smartphones/galaxy-a/galaxy-a54-5g-awesome-graphite-256gb-sm-a5460zkdtgy/'},
] as const

export type MobileDeviceProfile = (typeof MOBILE_DEVICE_PROFILES)[number]
export type MobileDeviceProfileId = MobileDeviceProfile['id']
export function getMobileDeviceProfile(id:unknown):MobileDeviceProfile|undefined {
  return typeof id === 'string' ? MOBILE_DEVICE_PROFILES.find(profile=>profile.id === id) : undefined
}
