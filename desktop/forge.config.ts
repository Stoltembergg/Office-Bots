import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'Office Bots',
    executableName: 'office-bots',
    appBundleId: 'com.officebots.app',
    appCategoryType: 'public.app-category.productivity',
  },
  makers: [
    new MakerZIP({}, ['darwin', 'linux', 'win32']),
    new MakerSquirrel(
      { name: 'office-bots', authors: 'Office Bots contributors' },
      ['win32'],
    ),
    new MakerDMG({}, ['darwin']),
  ],
};

export default config;
