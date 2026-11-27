const cardGroups = await Promise.all(
    matches.map((item) =>
      buildStreamCards(
        cfg,
        item,
        activeSession.serverUrl,
        activeSession.accessToken,
        foundItems[0]?.Name
      )
    )
  );
  return cardGroups.flat();
