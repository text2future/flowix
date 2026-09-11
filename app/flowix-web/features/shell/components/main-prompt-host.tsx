import type { DshRuntimeInstallerState } from '@features/preferences/public/system-api';
import type { AppUpdaterState } from '@features/shell/public/system-api';
import { DshInstallPrompt } from '@features/preferences/public/dsh-install-prompt';
import { FloatingPromptStack } from '@features/shell/components/floating-prompt';
import { AppUpdatePrompt } from '@features/shell/components/prompts/app-update-prompt';
import { NavigationFailurePrompt } from '@features/shell/components/prompts/navigation-failure-prompt';

export interface MainPromptHostProps {
  updater: AppUpdaterState;
  dshInstallPromptOpen: boolean;
  dshInstaller: DshRuntimeInstallerState;
  onCloseDshInstallPrompt(): void;
  onDshIntroDisplayed(): void;
  onDshInstalled(): void;
}

export function MainPromptHost({
  updater,
  dshInstallPromptOpen,
  dshInstaller,
  onCloseDshInstallPrompt,
  onDshIntroDisplayed,
  onDshInstalled,
}: MainPromptHostProps) {
  return (
    <FloatingPromptStack>
      <NavigationFailurePrompt />
      <AppUpdatePrompt updater={updater} />
      <DshInstallPrompt
        open={dshInstallPromptOpen}
        installer={dshInstaller}
        onClose={onCloseDshInstallPrompt}
        onIntroDisplayed={onDshIntroDisplayed}
        onInstalled={onDshInstalled}
      />
    </FloatingPromptStack>
  );
}

