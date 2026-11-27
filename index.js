async function buildStreamCards(cfg, item, serverUrl, accessToken, seriesTitle = '') {
  let sources = Array.isArray(item.MediaSources) ? item.MediaSources : [];

  // Resolve real MediaSources / DirectStreamUrl via PlaybackInfo if missing on the episode object
  if (sources.length === 0) {
    try {
      const session = await getValidSession(cfg, false);
      const pbRes = await axios.post(
        `${serverUrl}/Items/${item.Id}/PlaybackInfo`,
        { UserId: session.userId },
        {
          params: { UserId: session.userId, IsPlayback: true, AutoOpenLiveStream: false },
          headers: {
            'X-Emby-Token': accessToken,
            'X-Emby-Authorization': EMY_AUTH_HEADER,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );
      if (Array.isArray(pbRes.data?.MediaSources) && pbRes.data.MediaSources.length > 0) {
        sources = pbRes.data.MediaSources;
      }
    } catch {
      // Fall back to direct item stream URL without a synthetic MediaSourceId
    }
  }

  if (sources.length === 0) {
    sources = [{ Id: null, Container: 'mp4', MediaStreams: [] }];
  }

  return sources.map((source) => {
    const streams = source.MediaStreams || [];
    const video = streams.find((s) => s.Type === 'Video') || {};
    const audio = streams.find((s) => s.Type === 'Audio') || {};

    let resLabel = 'Direct Play';
    if (video.Height >= 2100 || video.Width >= 3800) resLabel = '4K';
    else if (video.Height >= 1000 || video.Width >= 1900) resLabel = '1080p';
    else if (video.Height >= 700 || video.Width >= 1200) resLabel = '720p';
    else if (video.Height) resLabel = `${video.Height}p`;

    const videoCodec = video.Codec ? video.Codec.toUpperCase() : '';
    const audioCodec = audio.Codec ? audio.Codec.toUpperCase() : '';
    const channels = audio.Channels ? `${audio.Channels}ch` : '';
    const sizeStr = formatBytes(source.Size);

    const details = [resLabel, videoCodec, audioCodec, channels, sizeStr].filter(Boolean).join(' • ');
    const displayName = seriesTitle || 'Direct Stream';

    const subtitles =
      source.Id
        ? streams
            .filter((s) => s.Type === 'Subtitle' && s.IsExternal)
            .map((sub) => ({
              id: `${source.Id}-${sub.Index}`,
              lang: sub.Language || 'eng',
              url: `${serverUrl}/Videos/${item.Id}/${source.Id}/Subtitles/${sub.Index}/Stream.vtt?api_key=${accessToken}`,
            }))
        : [];

    let streamUrl;
    if (source.DirectStreamUrl) {
      const rawUrl = source.DirectStreamUrl.startsWith('http')
        ? source.DirectStreamUrl
        : `${serverUrl}${source.DirectStreamUrl.startsWith('/') ? '' : '/'}${source.DirectStreamUrl}`;
      streamUrl = rawUrl.includes('api_key=')
        ? rawUrl
        : `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}api_key=${accessToken}`;
    } else if (source.Id && source.Id !== item.Id) {
      streamUrl = `${serverUrl}/Videos/${item.Id}/stream?static=true&MediaSourceId=${encodeURIComponent(source.Id)}&api_key=${accessToken}`;
    } else {
      streamUrl = `${serverUrl}/Videos/${item.Id}/stream?static=true&api_key=${accessToken}`;
    }

    return {
      name: 'Silo',
      title: `${displayName}\n${details}`,
      url: streamUrl,
      ...(subtitles.length > 0 ? { subtitles } : {}),
      behaviorHints: {
        notWebReady: false,
        bingeGroup: `silo-${resLabel}`,
      },
    };
  });
}
