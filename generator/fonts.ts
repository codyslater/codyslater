import { GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
let registered = false;

export function registerFonts(): void {
  if (registered) return;
  const regularKey = GlobalFonts.registerFromPath(path.join(here, '../assets/JetBrainsMono-Regular.ttf'), 'JetBrains Mono');
  const boldKey = GlobalFonts.registerFromPath(path.join(here, '../assets/JetBrainsMono-Bold.ttf'), 'JetBrains Mono');
  if (!regularKey || !boldKey) {
    throw new Error('failed to register JetBrains Mono from assets/');
  }
  registered = true;
}
