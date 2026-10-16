/* What the spoken summaries can say (js/app.js picks a line at random, fills
 * in the {placeholders} and capitalises the first letter). Many pools are an
 * opener crossed with a core sentence, so they read naturally in any
 * combination while giving lots of variety; an empty opener means the core is
 * said on its own.
 *
 * Placeholders: {N} {nm} {svc} service names, {few} "one outage" / "two
 * outages", {fewIs} "one outage is" / "two outages are", {n} a number word,
 * {at} " around City" (or ""), {place} where (shape depends on the pool),
 * {what}/{What} what went wrong, {when}/{When} when, {dur} how long, {ms}
 * milliseconds, {others} ", and so is Zoom" style tail, {v} a voice name.
 */
(function () {
  'use strict';

  /** Every opener with every core ("" opener = the core alone). */
  const X = (openers, cores) => {
    const out = [];
    for (const o of openers) for (const c of cores) out.push(o ? `${o} ${c}` : c);
    return out;
  };
  /** Every core with every tail appended. */
  const T = (cores, tails) => {
    const out = [];
    for (const c of cores) for (const t of tails) out.push(c + t);
    return out;
  };

  // ── This room, about one service (tapped outage, while active) ──────────
  const ROOM_OPEN = ['', 'And', 'Also,', 'Plus,', 'Worth noting:', 'And locally,'];
  const roomDown = X(ROOM_OPEN, [
    "it's not reachable from this room.", "we can't reach it from here, either.", "this room can't get to it right now.",
    "it's not answering from here.", "it's down from this room too.", "this room can't reach it at the moment.",
    "it isn't responding from here.", "we're cut off from it in this room.", "from here, it's not answering at all.",
    "this room is affected; it won't connect."]);
  const roomSlow = X(ROOM_OPEN, [
    'you might notice it here, too.', "it's a bit slow from this room.", "it's dragging a little from here.",
    "this room's seeing it slow down.", 'you may feel that one here.', "it's a touch sluggish from this room.",
    "it's slower than usual from here.", 'this room is feeling some of it.', 'responses from here are a bit sluggish.',
    "it's lagging a little in this room."]);
  const roomFine = X(['', 'Good news:', 'Thankfully,', 'Still,', 'Either way,', "For what it's worth,", 'Happily,', 'Luckily,', 'On the bright side,'], [
    "it's fine from this room.", 'from here, it still looks fine.', "this room isn't feeling it.",
    'from here, it still looks healthy.', "nothing's wrong from this room.", 'this room is getting through fine.',
    "it's still working fine from here.", 'here, it seems unaffected.', "from where we're sitting, it's fine.",
    'this room can still reach it without trouble.']).concat(["It's fine from this room, so carry on.", "From here, all good. No need to panic."]);

  // ── Overview: how the internet is doing ─────────────────────────────────
  const healthCalm = X(['', 'Right now,', 'At the moment,', 'For now,', 'Good news:', 'Overall,'], [
    "the internet's in good shape.", 'things are calm on the internet.', "it's all quiet on the internet.",
    "nothing's broken out there.", "it's a calm moment on the internet.", "the internet's behaving itself.",
    'there are no active outages.', 'everything out there is running smoothly.', 'the internet looks healthy.',
    "there's nothing to worry about out there."]).concat(["The internet's having a suspiciously good day.", "Nothing's on fire. Enjoy it while it lasts.", "All quiet. Even the routers seem relaxed."]);
  const HEALTH_OPEN = ['', 'Right now,', 'At the moment,', 'For now,', 'Overall,', 'All in all,'];
  const healthFew = X(HEALTH_OPEN, [
    "it's mostly calm on the internet, with {few} still going.", "the internet's mostly healthy; just {fewIs} still going.",
    "it's pretty quiet out there, apart from {few}.", 'things look mostly fine, with {few} still open.',
    "the internet's in decent shape; {fewIs} still in progress.", "it's a fairly calm picture, with {few} still being worked on.",
    "there's not much going on, just {few}.", 'the internet is steady, with {few} still active.',
    "it's a quiet stretch, aside from {few}.", 'most things are running fine; {fewIs} still unresolved.']);
  const healthBusy = X(HEALTH_OPEN, [
    "it's a busy time on the internet, with {n} outages going.", "there's a fair bit going on: {n} active outages.",
    "the internet's a little rough, with {n} outages in progress.", "it's a noisy moment out there; {n} outages are active.",
    "there's quite a bit happening, {n} outages at once.", "it's not the calmest moment; {n} outages are still going.",
    'things are busy, with {n} outages underway.', "there's plenty going on; {n} outages are open.",
    "the internet's having a busy spell, with {n} active outages.", "it's a hectic stretch, {n} outages and counting."]).concat(["It's a busy day for the internet, and probably for a few on-call engineers.", "There's a lot going on; somewhere, a pager is buzzing.", "The internet's keeping people on their toes right now."]);

  // ── Overview: the service with the worst of it ──────────────────────────
  const WATCH = ['', ' Worth keeping an eye on.', ' That one is worth watching.'];
  const worstActiveRepeat = T([
    '{N} is having the hardest time, on and off all day and still going now.', "{N} has had a rough day, and it's still not over.",
    "the one to watch is {N}; it's been up and down all day and is still having trouble.", "{N} keeps running into trouble today, and it's at it again now.",
    '{N} has struggled all day, and the latest issue is still open.', '{N} is having a tough one; several outages today, one still going.',
    "it's been a bad day for {N}, and it isn't done yet.", '{N} stands out, with trouble on and off all day and an outage still open.',
    "{N} has been the problem child today, and it's still acting up.", "{N} has had repeated outages today, and there's one going right now."], WATCH);
  const worstActiveOne = T([
    '{N} is the one to watch, with a problem going on now.', 'the main thing right now is {N}, which is having trouble.',
    '{N} is the story at the moment; it has an issue in progress.', '{N} is having a problem right now.',
    'the headline right now is {N}, with an outage in progress.', '{N} is down at the moment.',
    "{N} has an outage that's still open.", 'the big one right now is {N}.',
    '{N} is the one having trouble right now.', 'right now, all eyes are on {N}.'], WATCH);
  const worstPastRepeat = T([
    '{N} has had the roughest day, on and off.', '{N} has had a bumpy day, with trouble on and off.',
    "it's been an up and down day for {N}.", "{N} has had the most trouble today, though it's quiet now.",
    '{N} has had several outages today, all cleared now.', '{N} has been the least reliable today, on and off.',
    '{N} had a string of outages today, now resolved.', "{N} kept having trouble earlier, but it's settled down.",
    "today's most troubled service has been {N}.", "{N} has had a choppy day, though it's fine at the moment."],
  ['', ' Nothing open there right now, though.', ' All quiet there for now.']).concat(["{N} has had the kind of day that needs a long coffee break.", "{N} has been up and down so much today, it could use a nap."]);
  const worstPastOne = T([
    "{N} had the biggest outage, though it's cleared now.", "the biggest one today was at {N}, and that's resolved.",
    '{N} had the most notable outage today, now cleared.', "{N} had today's largest outage, since fixed.",
    'the standout today was an outage at {N}, now over.', "{N} had the most widespread problem today; it's fine now.",
    "{N} took the biggest hit today, but it's recovered.", "the biggest disruption today was {N}, and it's back to normal.",
    '{N} had a sizable outage earlier, now cleared.', "the largest outage today hit {N}; it's resolved."],
  ['', ' Nothing serious since.', " It's been fine since."]);
  // "... and Amazon had <this>."
  const restTail = X(['a few', 'some', 'a couple of', 'a handful of', 'several', 'a few quick', 'some short', 'a couple of brief', 'some minor'], [
    'hiccups', 'blips', 'glitches', 'bumps', 'wobbles', 'hiccups too', 'blips as well', 'issues', 'disruptions', 'outages of their own']);

  // ── Overview: this room ─────────────────────────────────────────────────
  const overviewRoomFine = X(['', 'And', 'Meanwhile,', 'Closer to home,', 'Locally,', 'On our side,'], [
    'everything this room relies on is answering normally.', 'all the services you use look fine from here.',
    'this room is in good shape.', 'everything you use from this room is working.', 'all looks well from here.',
    "everything's answering fine from this room.", "this room's connections all look healthy.",
    "nothing's wrong with the services this room uses.", 'every service we check from here is fine.',
    'this room is getting through to everything.']);
  const NOTE = ['', 'One thing to note:', 'Closer to home,'];
  const overviewRoomDown = X(NOTE, [
    "from this room, {svc} isn't answering{others}.", "here, {svc} isn't reachable right now{others}.", "this room can't reach {svc}{others}.",
    '{svc} is down from here{others}.', "we can't get to {svc} from this room{others}.", "{svc} isn't responding from here{others}.",
    'this room is cut off from {svc}{others}.', "{svc} won't connect from this room{others}.", 'from here, {svc} is unreachable{others}.',
    "{svc} isn't getting through from this room{others}."]);
  const overviewRoomSlow = X(NOTE, [
    'from this room, {svc} is slower than usual{others}.', 'here, {svc} is a little slow right now{others}.', '{svc} is lagging from this room{others}.',
    '{svc} is a bit sluggish from here{others}.', 'this room is seeing {svc} slow down{others}.', '{svc} is dragging a little from here{others}.',
    'responses from {svc} are slow in this room{others}.', '{svc} is taking longer than usual from here{others}.', 'from here, {svc} feels slow{others}.',
    '{svc} is running slow for this room{others}.']);

  // ── New outage ──────────────────────────────────────────────────────────
  const headsUp = X(['Heads up:', 'Just in:', 'New outage:'], [
    '{nm} just went down{at}.', '{nm} is having trouble{at}.', '{nm} has a new problem{at}.', '{nm} just started having issues{at}.',
    "something's wrong at {nm}{at}.", '{nm} has gone down{at}.', '{nm} is reporting an outage{at}.', '{nm} just hit a snag{at}.',
    '{nm} is struggling{at}.', "there's a fresh outage at {nm}{at}."]).concat(["Heads up: {nm} just went down{at}. Somebody's phone is ringing.", "New outage: {nm}{at}. The day just got more interesting."]);

  // ── A tapped outage: what's wrong (noun phrases) ────────────────────────
  // Noun phrases only, so they fit any sentence shape below.
  const NET = ['a network problem', 'trouble on its network', 'a problem in its network', 'a network issue', 'a fault in its network',
    'a routing problem', 'congestion on its network', 'a network outage', 'connectivity trouble', 'a problem in its backbone',
    'packet loss on its network', 'a network slowdown', 'a broken link somewhere in its network', 'routing trouble', 'an outage on its network',
    'a network disruption', 'a fault on its links', 'an interface problem', 'a network hiccup', 'a connectivity outage'];
  const APP = ['an application problem', 'trouble with its service', 'a service outage', 'unresponsive servers', 'a service slowdown',
    'an issue with its application', 'failing requests', 'a problem on its servers', 'timeouts on its service', 'errors from its service',
    'a service disruption', 'an app outage', 'server errors', 'slow responses from its servers', 'a backend problem',
    'an issue with its servers', 'requests timing out', 'a service failure', 'an application outage', 'trouble reaching its servers'];
  const whatNetNow = X(['', 'what looks like', 'what seems to be'], NET);
  const whatAppNow = X(['', 'what looks like', 'what seems to be'], APP);
  const whatNetThen = X(['', 'what looked like', 'what seemed to be'], NET);
  const whatAppThen = X(['', 'what looked like', 'what seemed to be'], APP);

  // {place} here is ", mostly around City and a few other places" (or "").
  const tappedActive = [
    "{nm}. {What}{place}, and it's still going.", '{nm}: {what}{place}. Still in progress.', "This is {nm}. {What}{place}, and it hasn't cleared yet.",
    "{nm}. {What}{place}. It's ongoing.", "Here's {nm}: {what}{place}, still unresolved.", "{nm} has {what}{place}, and it's still happening.",
    '{nm}. {What}{place}; no fix yet.', "That's {nm}, with {what}{place}. It's still going.", '{nm}, right now: {what}{place}.',
    "{nm}. {What}{place}, and it's not over yet.", '{nm} is dealing with {what}{place}.', 'Looking at {nm}: {what}{place}, still active.',
    '{nm}. Currently, {what}{place}.', '{nm}: still seeing {what}{place}.', "This one's {nm}. {What}{place}, ongoing.",
    "{nm}. {What}{place}, and it's active now.", '{nm} is in the middle of {what}{place}.', '{nm}. Reports show {what}{place}, still going.',
    '{nm}: {what}{place}, and counting.', '{nm}. Ongoing: {what}{place}.', 'So, {nm}. {What}{place}, still open.',
    '{nm}. {What}{place}. Not resolved yet.', '{nm} has an open issue: {what}{place}.', '{nm}. {What}{place}, as we speak.',
    '{nm}, live right now: {what}{place}.', "{nm}. It's {what}{place}, still going.", '{nm}. Seeing {what}{place} right now.',
    "{nm}: {what}{place}. They're still on it.", "{nm}. {What}{place}, and it's ongoing.", '{nm}. {What}{place}, unresolved so far.'];
  // {place} here is " around City and a few other places" (or "").
  const tappedCleared = [
    "{nm}. {When}, {what}{place}. It lasted {dur}, and it's cleared now.", '{nm} had {what}{place} {when}. That lasted {dur} and is resolved.',
    'This was {nm}, {when}{place}. {What} for {dur}, all clear now.', "{nm}. {When}, {what}{place}, for {dur}. It's fine now.",
    '{nm}: {what}{place}, {when}. Over after {dur}.', '{nm}. {What}{place}, {when}. It cleared after {dur}.',
    '{When}, {nm} had {what}{place}. It lasted {dur}.', "{nm}. {What}{place}, {when}, for {dur}. It's resolved.",
    "Looking back at {nm}: {what}{place}, {when}. It's been fixed.", '{nm}. {When}, {what}{place}. Back to normal after {dur}.',
    "{nm} ran into {what}{place} {when}, for {dur}. It's sorted now.", '{nm}. That was {when}: {what}{place}, for {dur}.',
    '{When}, {what}{place} at {nm}. It cleared after {dur}.', '{nm}. {What}{place}, {when}. All good now.',
    "This one's {nm}, {when}. {What}{place}, lasting {dur}.", '{nm}: {when}, {what}{place}. Resolved after {dur}.',
    "{nm}. {What}{place}, {when}, and it's over now.", '{nm} had {what}{place} {when}; it lasted {dur}.',
    '{nm}. {When}, {what}{place}. Fixed after {dur}.', "{nm}: {what}{place} {when}. It's cleared up.",
    '{nm}. A past one: {what}{place}, {when}, for {dur}.', "{nm}. {When}, {what}{place}. It didn't last; {dur}.",
    '{nm}. {What}{place}, {when}. Done after {dur}.', "Back {when}, {nm} had {what}{place}. It's fine now.",
    "{nm}: {what}{place}, {when}, for {dur}. It's recovered.", '{nm}. {When}, {what}{place}, which cleared after {dur}.',
    "{nm}. {What}{place}, {when}. It's been resolved.", '{nm} saw {what}{place} {when}. That lasted {dur}.',
    '{nm}. {When}: {what}{place}, over after {dur}.',
    "{nm}. {What}{place}, {when}. It's all clear."];

  // ── Path trace ──────────────────────────────────────────────────────────
  const pathStart = X(['', 'Okay,', 'Sure,'], [
    'let me trace the path to {svc}.', "I'll trace the route to {svc}.", "let's see how traffic gets to {svc}.",
    'tracing the path to {svc} now.', "I'm checking the route to {svc}.", "let's follow the path to {svc}.",
    'running a path trace to {svc}.', "let's see what's between here and {svc}.", 'mapping the route to {svc}.',
    'one moment, tracing {svc}.']);
  const pathLead = X(['', 'From the probe,', 'Right now,'], [
    '{svc} is about {ms} milliseconds away.', 'it takes about {ms} milliseconds to reach {svc}.', '{svc} is roughly {ms} milliseconds out.',
    'the round trip to {svc} is about {ms} milliseconds.', '{svc} answers in about {ms} milliseconds.', 'reaching {svc} takes around {ms} milliseconds.',
    '{svc} is {ms} milliseconds or so away.', "it's about {ms} milliseconds to {svc}.", '{svc} responds in roughly {ms} milliseconds.',
    'getting to {svc} takes about {ms} milliseconds.']);
  const pathSlow = X(['', 'That said,', 'Note that'], [
    'most of the delay comes in one jump{at}.', "there's one slow stretch{at}.", 'most of that time is spent on a single hop{at}.',
    'one hop{at} adds most of the delay.', 'the slow part is a single link{at}.', "there's a noticeable jump in delay{at}.",
    'one segment{at} is doing most of the slowing.', 'a single hop{at} accounts for most of it.', 'the path slows down sharply{at}.',
    "there's a bottleneck{at}."]);
  const pathLoss = X(['', 'Also,', 'One thing:'], [
    "there's some packet loss along the way{at}.", 'a few packets are getting lost{at}.', "there's a bit of loss on the path{at}.",
    "some packets aren't making it{at}.", 'the path is dropping a few packets{at}.', "there's packet loss showing up{at}.",
    "we're losing some packets{at}.", 'a little loss shows up{at}.', 'some of the traffic is being dropped{at}.', "there's a lossy hop{at}."]);
  const pathClean = X(['', 'Overall,', 'Good news:', 'Happily,', 'All in all,', 'So far,'], [
    'the path looks clean.', 'there are no problems along the way.', 'nothing looks wrong on the path.', "it's clean all the way there.",
    'every hop looks healthy.', "the route's in good shape.", 'no slow spots or loss along the way.', 'the whole path looks healthy.',
    "there's nothing to worry about on the route.", 'the trip there is smooth.']).concat(["The path is clean. Nothing to see here, in the best way.", "Smooth sailing all the way there."]);
  const pathNoAnswer = X(['', 'Hmm,', 'Unfortunately,'], [
    "{svc} didn't answer the trace.", "the trace couldn't reach {svc}.", "there's no answer from {svc} on that trace.",
    "{svc} didn't respond to the trace.", 'the trace never got a reply from {svc}.', "we couldn't get through to {svc}.",
    '{svc} stayed silent on the trace.', 'the trace to {svc} came back empty.', 'no reply from {svc} this time.', "{svc} isn't answering traces."]);

  // ── Voice picker samples ────────────────────────────────────────────────
  const voiceHello = ["Hi, I'm {v}.", "Hello, this is {v}.", "Hey there, I'm {v}.", "{v} here.", "Hi! {v} speaking.",
    "Hello, I'm {v}. Nice to meet you.", "This is {v}.", "Hi there, {v} here.", "Hey, it's {v}.", "Good to meet you, I'm {v}."];
  const speedSample = X(['', 'Okay,', 'Alright,'], [
    'this is how fast I talk now.', 'is this a good pace?', "here's the new speed.", 'how does this pace sound?',
    "this is my new speaking speed.", "let me know if this is too fast or too slow.", "here's how I sound at this speed.",
    'this pace should be easy to follow.', "I'll talk at this speed from now on.", 'testing the new pace.']);

  // ── Insights: patterns across outages (js/insights.js) ─────────────────
  // {likely} is 'very likely' / 'likely' / 'possibly', from the pattern's
  // score. About a quarter of the lines carry light humour (a 4 out of 10).
  const insightFirst = ['Connecting a few dots.', "Here's something interesting.", 'One pattern stands out.', 'Looking across the data,',
    'Putting on my detective hat for a second.', "Now, here's where it gets interesting.", 'Reading between the lines,',
    "Here's what the data is hinting at.", 'A quick bit of analysis.', 'Zooming out for a moment.', "If you look closely, there's a story here.",
    'Time for a little internet detective work.'];
  const insightNext = ['Another pattern:', 'Also worth noting.', "And here's another thread.", 'One more thing.', 'Meanwhile,',
    'Elsewhere in the data,', 'Another connection:', 'And while we are at it,', 'Next clue.', 'On a related note,',
    "Here's another one.", 'Plot twist, sort of.'];

  const sameCompanyFirst = [
    "{co}'s own network went down about {lead} minutes before {app} did. When a company's network fails first, its apps usually follow, so this is {likely} one story, not two.",
    "First {net}'s network dropped, then {lead} minutes later {app} started failing. Same company, same afternoon: {likely} cause and effect.",
    "{app} went down {lead} minutes after {co}'s network did. That ordering {likely} points at the network as the root cause.",
    "The timeline is telling: {co}'s network fails, and {lead} minutes later {app} follows. One {likely} caused the other.",
    "{co} had a network problem, and {lead} minutes later {app} joined in. The network is {likely} where it started.",
    "Watch the order: {co}'s network first, {app} {lead} minutes later. That's {likely} a single incident rippling up the stack.",
    "{co}'s network stumbled, and {app} tripped over it about {lead} minutes later.",
    "{app} didn't fail alone; {co}'s network went down {lead} minutes earlier. {likely} the same root cause.",
    "It looks like a domino effect at {co}: network first, then {app}, {lead} minutes apart.",
    "{co}'s network blinked first, and {app} followed {lead} minutes later. Somebody at {co} is having a busy shift."];
  const sameCompanyTogether = [
    "{co} had trouble on both fronts at once: its own network and {app}. When a company's network and its app fail together, they're {likely} the same incident.",
    "{app} and {co}'s network went down at about the same time. That's {likely} one problem showing up in two places.",
    "Both {co}'s network and {app} had problems in the same window. Two symptoms, {likely} one cause.",
    "{co} is having a moment: its network and {app} failed together. The network is the usual suspect.",
    "Same company, same time: {co}'s network and {app}. That's {likely} not a coincidence.",
    "{app} and {co}'s own network stumbled together; {likely} one underlying issue.",
    "{co}'s network and {app} went down side by side. The two are {likely} connected.",
    "When {co}'s network has a bad moment, {app} feels it. That's {likely} what happened here.",
    "{co} managed to break its network and {app} at the same time. Efficient, in its own way.",
    "Two {co} outages at once, the network and {app}. {likely} related."];
  const sameCompanyApart = [
    "{co} had a rough day on two levels: its network and {app} both had outages, though at different times.",
    "{co} shows up twice today, once for its network and once for {app}. Probably separate issues.",
    "Both {co}'s network and {app} had problems today, hours apart. Likely unrelated, but not a great day for them.",
    "{co} had separate network and {app} outages today. Two different headaches.",
    "{co}'s network and {app} each had their turn today. Not at the same time, so probably not the same cause.",
    "Today {co} had trouble with both its network and {app}. Separate incidents, by the look of it.",
    "{co} got it from both sides today: network and {app}, at different times.",
    "{co}'s network and {app} took turns having problems today."];

  const netAppFirst = [
    "{net}'s network dropped around {city} about {lead} minutes before {app} started failing there. That ordering {likely} points to the network.",
    "In {city}, {net} went down first, and {app} followed {lead} minutes later. {app} {likely} runs through {net} there.",
    "First {net}, then {app}, both around {city}, {lead} minutes apart. {likely} cause and effect.",
    "{app}'s trouble near {city} started {lead} minutes after {net} had a network outage there. Not a coincidence, {likely}.",
    "The order matters: {net} failed around {city}, then {app} did. {app} {likely} depends on {net} in that area.",
    "Around {city}, {net}'s outage came {lead} minutes before {app}'s. Follow the packets, and they {likely} lead to {net}.",
    "{net} hiccuped near {city}, and {app} caught the cold {lead} minutes later.",
    "{app} had problems in {city}, but {net}'s network got there first, {lead} minutes earlier.",
    "Near {city}, {net} went down and {app} went down right after. {likely} the same root cause.",
    "Look at {city}: {net} first, {app} {lead} minutes later. Classic downstream effect."];
  const netAppTogether = [
    "{app} and {net} both failed around {city}, and they recovered together too. That's {likely} one problem.",
    "Around {city}, {app} and {net} went down and came back at about the same time. {likely} connected.",
    "{net} and {app} had matching outages near {city}: same start, same finish. Hard to call that a coincidence.",
    "In {city}, {app} and {net} failed and recovered in lockstep. {likely} the same incident.",
    "{app} and {net} near {city}: down together, back together. They {likely} share a path there.",
    "Same place, same time, same recovery: {app} and {net} around {city}. {likely} one story.",
    "{app} and {net} around {city} seem to have synchronized their outages. Not ideal choreography.",
    "Near {city}, {net}'s outage and {app}'s lined up almost exactly. {likely} related."];
  const netAppPlain = [
    "{app} and {net} both had problems around {city} at the same time. They're {likely} related.",
    "Around {city}, {app}'s outage overlaps with one on {net}'s network. {likely} connected.",
    "{net} and {app} both stumbled near {city} in the same window. Worth a closer look.",
    "There's overlap in {city}: {net}'s network and {app} both had issues. {likely} linked.",
    "{app}'s outage near {city} lines up with trouble on {net}'s network there.",
    "In {city}, {app} and {net} had problems at the same time. {likely} not a coincidence.",
    "{net} and {app} were both having a bad time around {city}. Misery loves company.",
    "Around {city}, {app} and {net} overlap. {likely} the same root cause."];
  const netTypeTail = {
    edge: [' {net} is an edge network, so {app} may simply sit behind it.', ' Since {net} runs edge and CDN services, {app} could be one of its customers.',
      ' {net} is a CDN, and a lot of apps live behind CDNs.', ' {net} fronts a lot of websites, so a ripple effect would make sense.',
      ' With {net} being an edge provider, that kind of knock-on effect is common.', ' {net} carries a lot of web traffic at the edge, so this fits.'],
    transit: [' {net} is a backbone carrier, so plenty of traffic passes through it.', ' {net} is a transit provider; a lot of routes depend on it.',
      ' {net} carries traffic for many others, so its problems tend to spread.', ' As a backbone carrier, {net} affects more than its own customers.',
      " {net} is one of the internet's highways, so a closure there causes detours.", ' Backbone trouble at {net} would explain it.'],
    cloud: [' {net} hosts a lot of services, and {app} could be one of them.', ' {net} is a big cloud provider, so {app} may run on it.',
      ' Plenty of apps run on {net}, which would explain the overlap.', ' {app} {likely} has some of its infrastructure on {net}.',
      ' Cloud providers like {net} host a lot of apps, so this fits.', " If {app} runs on {net}, that's the link."],
    network: ['', '', '', '', '', ''],
  };

  const cluster = [
    "Something happened around {city}: {n} different providers, including {a} and {b}, had problems within the same hour. That points to a local event, like a fiber cut or a power issue.",
    "{city} had a rough hour: {n} providers, {a} and {b} among them, all had outages close together. Probably something local.",
    "Lots of activity around {city}: {n} providers failed within the same hour. When that happens, the cause is usually physical: power, fiber, or a data center.",
    "{n} providers had trouble near {city} at about the same time, including {a} and {b}. That's {likely} one local event, not {n} bad days.",
    "Around {city}, {a}, {b} and others all failed within the hour. {likely} a shared local cause.",
    "{city} looks like the epicenter: {n} providers with outages in the same hour.",
    "When {n} providers fail in {city} in the same hour, it's rarely a coincidence. Something local {likely} broke.",
    "{city} had a cluster of outages: {a}, {b}, and more. Somebody may have found a fiber line with a shovel.",
    "{n} providers around {city}, including {a} and {b}, went down close together. That's {likely} a regional event.",
    "A cluster in {city}: {n} providers in one hour. That's a neighborhood problem, not a provider problem."];
  const sharedHosting = [
    "{a} and {b} both went down in {city} at the same time. They {likely} share a data center or an upstream provider there.",
    "In {city}, {a} and {b} failed together. Two different apps, {likely} one shared piece of infrastructure.",
    "{a} and {b} had overlapping outages around {city}. They {likely} have a common dependency there.",
    "Two apps, one city: {a} and {b} both stumbled in {city}. {likely} a shared host or network.",
    "{a} and {b} both had trouble near {city} at once. It's {likely} something they share.",
    "Around {city}, {a} and {b} went down together. {likely} neighbors in the same data center.",
    "{a} and {b} picked the same time and place to have problems: {city}. Shared infrastructure is the {likely} reason.",
    "{a} and {b} in {city}, down at the same moment. Roommates, maybe.",
    "When {a} and {b} fail together in {city}, the shared piece is the place to look.",
    "{a} and {b} overlap in {city}. {likely} one upstream problem."];
  const sameMinute = [
    "{n} providers, {a} and {b} among them, started failing within the same five minutes on different continents. Could be coincidence, or a shared dependency like DNS.",
    "Within five minutes, {a}, {b} and others started having problems, far apart from each other. If it's not coincidence, look at shared services like DNS or a CDN.",
    "{n} providers on different continents started failing at nearly the same moment, including {a} and {b}. {likely} a shared dependency.",
    "{a} and {b} started having trouble within minutes of each other, on opposite sides of the world. Either a coincidence or a common dependency.",
    "{n} outages started almost simultaneously in different parts of the world. Suspiciously good timing.",
    "{a}, {b} and others all started failing in the same five minutes, continents apart. That sometimes means DNS or an identity service.",
    "{n} providers across the globe started having problems at once, {a} and {b} among them. The internet's version of a group chat.",
    "Simultaneous trouble at {a}, {b} and more, far apart. {likely} a shared upstream piece."];
  const repeatActive = [
    "{N} has had {n} separate outages today, and it's still having trouble now.", "{N} keeps coming back: {n} outages today, and the latest is still open.",
    "{N} is on outage number {n} for the day, and it's not done yet.", "{n} outages so far today for {N}, with one still going.",
    "{N} has had {n} outages today. Someone over there is having a very long day.", "{N} is having a stubborn day: {n} outages, one still in progress.",
    "{n} outages today and counting for {N}.", "{N} can't quite shake it: {n} outages today, and still going."];
  const repeatPast = [
    "{N} had {n} separate outages today. Each one was short, but that's a pattern, not bad luck.",
    "{N} went down {n} times in the last day. Repeated short outages often point to something unstable, like a flapping link.",
    "{n} outages for {N} today. They cleared each time, but kept coming back.",
    "{N} has had {n} outages in the last day. That kind of repetition usually has one underlying cause.",
    "{N} keeps having short outages, {n} today. Good thing they're quick.",
    "{N} has been flapping: {n} outages in the last day, all cleared now.",
    "{n} separate times today, {N} had trouble. That's a pattern worth watching.",
    "{N} has been on and off all day, {n} times in total. Like a light switch nobody can leave alone.",
    "{N} has racked up {n} outages today, all resolved. Persistent, if nothing else.",
    "{n} outages at {N} today. Each brief, but the count is the story."];
  const wideNet = [
    "{N}'s network outage reached {n} countries at once. That's backbone-level reach.",
    "{N}'s outage spanned {n} countries. When a network fails that widely, it's usually core routing, not a single site.",
    "{N} had a network outage across {n} countries at the same time. That's a wide blast radius.",
    "One {N} outage touched {n} countries. That's the kind that gets people paged at night.",
    "{N}'s problem wasn't local: {n} countries saw it together.",
    "{n} countries, one outage: {N}'s network had a wide one.",
    "{N}'s outage went global, across {n} countries. That {likely} means something central broke.",
    "A {N} outage across {n} countries. Not a great day for their network team."];
  const wideApp = [
    "{N}'s outage showed up in {n} countries at once. When an app fails everywhere together, it's usually something central, like login or a global load balancer.",
    "{N} failed across {n} countries at the same time. That {likely} points to a shared front door, not regional servers.",
    "{N}'s outage spanned {n} countries. Global failures like that tend to come from a central service.",
    "{N} went down in {n} countries at once. Something central {likely} broke.",
    "One {N} outage, {n} countries. That's a big one.",
    "{N}'s outage reached {n} countries together, which usually means authentication or configuration, not hardware.",
    "{N} had a worldwide wobble, {n} countries at once.",
    "Across {n} countries, {N} failed together. {likely} a single global component."];
  const maintenance = [
    "The {N} outage near {city} happened in the middle of the night, local time, and was short. That looks a lot like planned maintenance.",
    "{N} had a short outage around {city} in the small hours, local time. Probably a maintenance window.",
    "That {N} blip near {city} came overnight, local time, and didn't last. Classic maintenance timing.",
    "{N}'s short outage around {city} happened when most people were asleep. {likely} scheduled work.",
    "An overnight, short outage at {N} near {city}. Someone {likely} did maintenance while the coffee was still brewing.",
    "{N} near {city}: short, overnight, then fine. That's the signature of planned work.",
    "{N} went quiet briefly around {city} in the middle of the night. Probably maintenance.",
    "The timing of {N}'s outage near {city}, overnight and brief, suggests planned maintenance."];
  const insightRoomSlow = [' And {room} is slow from this room right now, which may be why.', ' That may also explain why {room} feels slow here.',
    ' It could be why {room} is lagging from this room.', ' This room is seeing {room} slow down too, so it may be related.',
    ' {room} is sluggish from here right now, and this {likely} explains it.', ' It might be the reason {room} is dragging in this room.'];
  const insightRoomDown = [" And {room} isn't reachable from this room right now, which this may explain.", " That may be why this room can't reach {room}.",
    ' It could explain why {room} is down from here.', " This room can't reach {room} either, so they're {likely} connected.",
    ' {room} is down from this room too, and this is the {likely} reason.', " It may be why {room} isn't answering here."];

  window.PHRASES = {
    roomDown, roomSlow, roomFine,
    healthCalm, healthFew, healthBusy,
    worstActiveRepeat, worstActiveOne, worstPastRepeat, worstPastOne, restTail,
    overviewRoomFine, overviewRoomDown, overviewRoomSlow,
    headsUp, whatNetNow, whatAppNow, whatNetThen, whatAppThen, tappedActive, tappedCleared,
    pathStart, pathLead, pathSlow, pathLoss, pathClean, pathNoAnswer,
    voiceHello, speedSample,
    insightFirst, insightNext, sameCompanyFirst, sameCompanyTogether, sameCompanyApart,
    netAppFirst, netAppTogether, netAppPlain, cluster, sharedHosting, sameMinute,
    repeatActive, repeatPast, wideNet, wideApp, maintenance, insightRoomSlow, insightRoomDown,
    netTypeEdge: netTypeTail.edge, netTypeTransit: netTypeTail.transit, netTypeCloud: netTypeTail.cloud,
  };
})();
