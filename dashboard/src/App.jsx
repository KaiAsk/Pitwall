const arionSummary = useMemo(() => {
    const agg = {};
    seasonSessions.forEach((s) => {
      
      (s.penalties || []).forEach((p) => {
        const pKart = String(p.kart || "");
        const kartObj = s.karts.find(k => 
          (pKart && k.num === pKart) || 
          (p.team && k.teamName.toLowerCase() === (p.team || "").toLowerCase())
        );
        if (!kartObj) return;

        const key = `${s.id}|${kartObj.num}`;
        if (removed.has(key)) return;
        const name = assign[key]?.trim();
        if (!name) return;

        const a = agg[name] || (agg[name] = { name, qPos: [], qGap: [], rGap: [], pGap: [], penPos: 0, pens: 0 });
        a.pens += 1;
        
        const m = String(p.penalty || "").match(/(\d+)\s*(grid|place|pos)/i);
        if (m) {
          a.penPos += Number(m[1]);
        } else if (/exclud|exclusion|dsq|disqual/i.test(p.penalty || "") || /exclud|dsq|disqual/i.test(p.reason || "")) {
          const lost = s.posByKart ? s.posByKart[kartObj.num] : 0;
          if (lost < 0) {
            a.penPos += Math.abs(lost);
          } else {
            a.penPos += Math.floor((s.allKarts ? s.allKarts.length : 30) / 2); 
          }
        }
      });

      if (!s.isRound) return;
      const isQuali = /quali/i.test(s.raceLabel);
      const isRace = /race/i.test(s.raceLabel) && !isQuali;
      if (!isQuali && !isRace) return;
      const isWet = wetSessions.has(s.id);

      // EXCLUDE WET RACES FROM SUMMARY GAPS
      if (isWet) return;

      const bests = (s.allKarts || []).map((k) => s.sectorsByKart && s.sectorsByKart[k.num] && s.sectorsByKart[k.num].best).filter((x) => x != null);
      const fastest = bests.length ? Math.min(...bests) : null;
      const wFast = weekendFastest[s.round]; 

      s.karts.forEach((k) => {
        const key = `${s.id}|${k.num}`;
        if (removed.has(key)) return;
        const name = assign[key]?.trim();
        if (!name) return;
        
        const a = agg[name] || (agg[name] = { name, qPos: [], qGap: [], rGap: [], pGap: [], penPos: 0, pens: 0 });
        const best = s.sectorsByKart && s.sectorsByKart[k.num] ? s.sectorsByKart[k.num].best : null;
        
        const gap = (best != null && fastest != null) ? best - fastest : null;
        
        if (isQuali) {
          if (s.finByKart && s.finByKart[k.num] != null) a.qPos.push(s.finByKart[k.num]);
          if (gap != null) a.qGap.push(gap);
        } else if (isRace) {
          if (gap != null) a.rGap.push(gap);
          // FIX: Now correctly comparing your BEST lap to the weekend's absolute BEST lap
          if (best != null && wFast != null) {
            a.pGap.push((best - wFast) * 10);
          }
        }
      });
    });
    
    const avg = (x) => (x.length ? x.reduce((p, c) => p + c, 0) / x.length : null);
    return Object.values(agg).map((d) => ({ 
      name: d.name, 
      avgQpos: avg(d.qPos), 
      avgQgap: avg(d.qGap), 
      avgRgap: avg(d.rGap), 
      avgPgap: avg(d.pGap), 
      penPos: d.penPos, 
      pens: d.pens 
    }));
  }, [seasonSessions, assign, removed, weekendFastest, wetSessions]);