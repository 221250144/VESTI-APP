import type {
  VestiCapsuleApi,
  VestiDesktopApi,
  VestiMembershipApi,
  VestiUiPrefsApi,
  VestiWindowApi,
} from './shared/contracts';

declare global {
  interface Window {
    vesti: VestiDesktopApi;
    vestiMembership: VestiMembershipApi;
    vestiUi?: VestiUiPrefsApi;
    vestiCapsule?: VestiCapsuleApi;
    vestiWindow?: VestiWindowApi;
  }
  const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
  const MAIN_WINDOW_VITE_NAME: string;
}

export {};
