import { resolveBilibili } from './bilibili-runtime';
import type { VideoInfo } from './types';

type VideoResolver = (video: VideoInfo) => Promise<VideoInfo>;
const resolvers: Partial<Record<VideoInfo['provider'], VideoResolver>> = {
  bilibili: resolveBilibili,
};

/** Editor-only registry: resolvers talk to the app client, never to a parse path. */
export function resolveProviderVideo(video: VideoInfo): Promise<VideoInfo> {
  const resolve = resolvers[video.provider];
  if (!resolve) return Promise.reject(new Error(`No metadata resolver for: ${video.provider}`));
  return resolve(video);
}
