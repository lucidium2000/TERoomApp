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
  const ROOM_OPEN = ['', 'And', 'Also,', 'Plus,', 'Worth noting:', 'And locally,', 'Here,', 'On our end,', 'In this room,', 'Locally,'];
  const roomDown = X(ROOM_OPEN, [
    "it's not reachable from this room.", "we can't reach it from here, either.", "this room can't get to it right now.",
    "it's not answering from here.", "it's down from this room too.", "this room can't reach it at the moment.",
    "it isn't responding from here.", "we're cut off from it in this room.", "from here, it's not answering at all.",
    "this room is affected; it won't connect.", "we're getting no response from it here.", "it's unreachable from where we sit.",
    "connections to it from here are failing.", "this room has lost it entirely.", "requests from here are going nowhere.",
    "it's dark from this room.", "our checks from here can't reach it.", "it's not coming through here at all.",
    "this room can't connect to it.", "from here, it simply doesn't answer.", "it's offline as far as this room can tell.",
    "we're locked out of it here.", "this room's requests to it are timing out.", "it's gone quiet from here.",
    "nothing gets through to it from this room.", "it isn't reachable on our end.", "from this room, it's down hard.",
    "our probe from here gets no answer.", "it's out of reach from this room.", "this room is cut off from it right now."]);
  const roomSlow = X(ROOM_OPEN, [
    'you might notice it here, too.', "it's a bit slow from this room.", "it's dragging a little from here.",
    "this room's seeing it slow down.", 'you may feel that one here.', "it's a touch sluggish from this room.",
    "it's slower than usual from here.", 'this room is feeling some of it.', 'responses from here are a bit sluggish.',
    "it's lagging a little in this room.", "it's answering, just slowly, from here.", "responses from here are taking longer than normal.",
    "this room is getting slower answers from it.", "it's a little laggy from where we sit.", "from here, it's slower than its usual self.",
    "our checks from here show it slowing down.", "it's working, but sluggishly, from this room.", "you'd notice a delay from here.",
    "it's dragging its feet from this room.", "the response times from here are up.", "it's running behind from this room.",
    "this room sees it lagging.", "it's a little slow on our end.", "from here, there's a noticeable delay.",
    "our probe from here shows it slower than normal.", "it's taking its time answering this room.", "things are a bit slower from here.",
    "this room is feeling some lag.", "it's not quite snappy from here.", "replies from it are slow in this room."]);
  const roomFine = X(['', 'Good news:', 'Thankfully,', 'Still,', 'Either way,', "For what it's worth,", 'Happily,', 'Luckily,', 'On the bright side,',
    'Reassuringly,', 'The upside:', 'Fortunately,', 'Relax:', 'Encouragingly,', 'Nicely,'], [
    "it's fine from this room.", 'from here, it still looks fine.', "this room isn't feeling it.",
    'from here, it still looks healthy.', "nothing's wrong from this room.", 'this room is getting through fine.',
    "it's still working fine from here.", 'here, it seems unaffected.', "from where we're sitting, it's fine.",
    'this room can still reach it without trouble.', "it's answering normally from here.", 'this room is unaffected.',
    'our checks from here look normal.', "it's business as usual from this room.", "from where we sit, it's working.",
    'this room still gets quick answers from it.', "it's healthy from our end.", 'nothing unusual from this room.',
    "it's responding fine here.", 'this room has no trouble reaching it.', "we're getting normal responses from here.",
    "it's running normally for this room.", "from here, there's nothing to see.", "it's all good from this room.",
    'our probe from here is happy.', 'this room is getting through normally.', "it's steady from where we are.",
    "everything's normal on our end.", "from this room, it's working as usual.", 'this room sees no problem.']).concat(["It's fine from this room, so carry on.", "From here, all good. No need to panic."]);

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
  const overviewRoomFine = X(['', 'And', 'Meanwhile,', 'Closer to home,', 'Locally,', 'On our side,', 'Here,', 'On our end,', 'For us,', 'Right here,',
    'Where we are,', 'Back home,', 'In the meantime,', 'As for us,', 'Nearer by,', 'At our end,'], [
    'everything this room relies on is answering normally.', 'all the services you use look fine from here.',
    'this room is in good shape.', 'everything you use from this room is working.', 'all looks well from here.',
    "everything's answering fine from this room.", "this room's connections all look healthy.",
    "nothing's wrong with the services this room uses.", 'every service we check from here is fine.',
    'this room is getting through to everything.', 'every service this room uses is answering normally.', 'all our services look healthy.',
    'nothing this room relies on is in trouble.', 'everything we use is working.', 'the services we use are all fine.',
    'this room is unaffected by all of it.', 'our connections all look normal.', "everything's green for this room.",
    'this room is getting normal responses everywhere.', 'none of this is reaching us.']);
  const NOTE = ['', 'One thing to note:', 'Closer to home,', 'Locally,', 'Here,', 'On our end,', 'Heads up:', 'Worth knowing:'];
  const overviewRoomDown = X(NOTE, [
    "from this room, {svc} isn't answering{others}.", "here, {svc} isn't reachable right now{others}.", "this room can't reach {svc}{others}.",
    '{svc} is down from here{others}.', "we can't get to {svc} from this room{others}.", "{svc} isn't responding from here{others}.",
    'this room is cut off from {svc}{others}.', "{svc} won't connect from this room{others}.", 'from here, {svc} is unreachable{others}.',
    "{svc} isn't getting through from this room{others}.", '{svc} is unreachable from here{others}.', "this room's requests to {svc} are failing{others}.",
    "{svc} isn't answering this room{others}.", "we've lost {svc} from here{others}.", '{svc} is offline as far as this room can tell{others}.',
    '{svc} is dark from this room{others}.', 'our checks to {svc} from here are failing{others}.', "{svc} can't be reached from where we sit{others}.",
    'this room gets no answer from {svc}{others}.', '{svc} is down on our end{others}.']);
  const overviewRoomSlow = X(NOTE, [
    'from this room, {svc} is slower than usual{others}.', 'here, {svc} is a little slow right now{others}.', '{svc} is lagging from this room{others}.',
    '{svc} is a bit sluggish from here{others}.', 'this room is seeing {svc} slow down{others}.', '{svc} is dragging a little from here{others}.',
    'responses from {svc} are slow in this room{others}.', '{svc} is taking longer than usual from here{others}.', 'from here, {svc} feels slow{others}.',
    '{svc} is running slow for this room{others}.', '{svc} is answering slowly from here{others}.', 'this room sees {svc} lagging{others}.',
    '{svc} is slower than normal on our end{others}.', 'our checks to {svc} show it slowing{others}.', '{svc} is taking its time from here{others}.',
    "{svc}'s responses are slow in this room{others}.", '{svc} is a little laggy from where we sit{others}.', '{svc} is dragging for this room{others}.',
    'this room notices {svc} running slow{others}.', '{svc} has slowed down from here{others}.']);

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
  // How the analyst opens: one natural phrase (never "Okay. So. ...").
  const glue = (as, bs) => { const out = []; for (const a of as) for (const b of bs) out.push(a + b); return out; };
  const insightFirst = glue(['Looking across the data', 'Connecting the dots', 'Reading between the lines', 'Zooming out for a moment', 'Taking a step back',
    'If you look closely', 'Comparing the outages', 'Lining up the timelines', 'Putting the pieces together', 'Cross-checking the outages'],
  ['', ', one thing stands out', ", here's a pattern", ', something interesting shows up', ", there's a story here", ', this jumps out']).map((t) => t + '.');
  const insightNext = glue(['Another pattern', 'Another connection', 'Another thread', 'One more pattern', 'A second story', 'Another link',
    'One more connection', 'Another observation', 'A related pattern', 'One more thread'],
  ['.', ':', ' worth a mention.', ' in the data.', ' that stands out.', ' to consider.']);

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
  // Said when we DON'T know whether the app uses that network (see the KB in
  // insights.js): describe the network, never claim the app is its customer.
  const netTypeTail = {
    edge: [" {net} runs edge and CDN services for many sites; whether {app} is one of them isn't clear from this data.", ' {net} fronts a lot of websites, but that alone doesn\'t mean {app} depends on it.',
      ' {net} is a CDN, and plenty of apps use CDNs, though this data can\'t confirm {app} does.', ' {net} is an edge provider; the overlap could be a dependency, or just a shared location.',
      ' Edge networks like {net} carry a lot of traffic, so a knock-on effect is possible, not proven.', ' It might be a dependency, or the two might simply share a building there.'],
    transit: [' {net} is a backbone carrier, so plenty of traffic passes through it, possibly some of {app}\'s users.', ' {net} is a transit provider; its trouble can affect paths to many services.',
      ' {net} carries traffic for many others, so its problems can spread, though the link to {app} isn\'t certain.', ' As a backbone carrier, {net} can affect users trying to reach {app}, not {app} itself.',
      " {net} is one of the internet's highways; when it closes, some routes to {app} may detour.", ' Backbone trouble at {net} could explain part of it.'],
    cloud: [' {net} is a big cloud provider; this data can\'t tell whether {app} runs there.', ' {net} hosts a lot of services; {app} may or may not be one of them.',
      ' Plenty of apps run on {net}, but that doesn\'t confirm {app} does.', ' If {app} runs on {net}, that would be the link; this data can\'t confirm it.',
      ' Cloud providers like {net} host many apps, so a link is possible.', " It's possible {app} has some infrastructure on {net}, but it isn't certain."],
    network: [' Whether {app} depends on {net} isn\'t clear from this data.', ' The two may share a location there, or it may be coincidence.',
      ' That might be a dependency, or just a shared place.', " It's a correlation, not proof.", ' Worth checking whether they share a path.', ' Could be connected, could be chance.'],
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

  // ── Day context for the overview (Insights.context) ───────────────────
  // Research notes behind these: ThousandEyes' weekly outage figures show only
  // about a third to a half of outages land in business hours (providers work
  // at night); routing (the control plane) is often behind large outages;
  // fiber cuts cause routing churn nearby; CDN, DNS and login services are
  // shared dependencies many apps lean on.
  const CTX_OPEN = ['', 'For context,', 'Zooming out,', 'Looking at the day as a whole,', 'One more thing about today:', 'Interestingly,'];
  const offHours = X(CTX_OPEN, [
    'most of the outages, about {pct} percent, happened outside business hours, which is normal; providers do their work at night.',
    'about {pct} percent of the trouble came outside working hours, the usual pattern for maintenance and changes.',
    'the bulk of today\'s outages hit while most people were off the clock; about {pct} percent.',
    'roughly {pct} percent of outages came at night or early morning, local time. Typical, since that\'s when changes get made.',
    'most problems happened outside business hours, about {pct} percent, so fewer people would have noticed.',
    'about {pct} percent of the outages landed outside the workday. The night shift earned its coffee.',
    'the outages mostly came outside business hours, around {pct} percent, which points to planned work.',
    'around {pct} percent of today\'s trouble came after hours, which is the usual rhythm of the internet.']);
  const bizHours = X(CTX_OPEN, [
    'about {pct} percent of today\'s outages hit during business hours, more than usual, so more people would have felt them.',
    'unusually, most outages, about {pct} percent, landed in the middle of the workday.',
    'roughly {pct} percent of the trouble came during working hours, which is when it hurts most.',
    'more outages than normal fell in business hours today, about {pct} percent.',
    'the timing was unlucky: about {pct} percent of outages arrived during the workday.',
    'about {pct} percent of outages came while people were at their desks. Not ideal timing.',
    'today skewed toward business hours, about {pct} percent of outages, which is above the usual third to half.',
    'most problems, around {pct} percent, landed during working hours, so they would have been noticed.']);
  const peakHour = X(CTX_OPEN, [
    'the busiest hour was around {hour}, with {n} outages starting then.', 'things peaked around {hour}, when {n} outages started.',
    '{hour} was the hot spot, with {n} outages kicking off.', 'if you had to pick a rough hour, it was around {hour}: {n} outages.',
    'the worst stretch was around {hour}, {n} outages in one hour.', 'around {hour}, {n} outages started within the same hour.',
    'the {hour} hour was the busiest, with {n} new outages.', 'activity spiked around {hour}, with {n} outages starting.']);
  const busier = X(CTX_OPEN, [
    'things have picked up in the last few hours compared with earlier in the day.', 'the last six hours have been busier than the rest of the day.',
    'outages have been coming faster lately.', 'the pace has picked up recently.', 'it\'s been a busier stretch in the last few hours.',
    'the trend is up: more outages lately than earlier.', 'activity has been climbing over the last few hours.',
    'the last few hours have been noisier than the morning.']);
  const quieter = X(CTX_OPEN, [
    'things have calmed down over the last few hours.', 'the last six hours have been quieter than earlier.', 'the pace has slowed down recently.',
    'it\'s been settling down lately.', 'outages have tapered off in the last few hours.', 'the trend is down: fewer outages lately.',
    'it\'s quieter now than it was earlier today.', 'the internet seems to be catching its breath.']);
  const region = X(CTX_OPEN, [
    'most of the action, about {pct} percent, has been in {region}.', '{region} has seen the most trouble today, about {pct} percent of outages.',
    'about {pct} percent of today\'s outages were in {region}.', 'the center of gravity today is {region}, with about {pct} percent of outages.',
    '{region} has had the busiest day, roughly {pct} percent of the outages.', 'if you\'re in {region}, today has been a bit bumpier than elsewhere.',
    '{region} accounts for most of the outages, around {pct} percent.', 'the map is busiest over {region} today.']);
  const spread = X(CTX_OPEN, [
    'outages touched {n} countries over the last day.', 'today\'s trouble reached {n} different countries.', '{n} countries saw at least one outage today.',
    'the outages were spread across {n} countries.', 'it\'s been a global day: {n} countries affected.', 'outages popped up in {n} countries.',
    'in all, {n} countries had some trouble today.', 'the map lights up in {n} countries.']);
  const netMost = X(CTX_OPEN, [
    'most of today\'s trouble was in networks: {net} network outages against {app} application ones.', 'networks had a harder day than apps, {net} outages to {app}.',
    'it\'s mostly been network trouble today; apps have been steadier.', 'the networks took the brunt of it today, {net} outages.',
    'network outages outnumber application outages {net} to {app}.', 'today was a network day: {net} network outages, {app} app outages.',
    'the plumbing had more trouble than the apps today.', 'more pipes than apps had problems today, {net} to {app}.']);
  const appMost = X(CTX_OPEN, [
    'most of today\'s trouble was in applications: {app} app outages against {net} network ones.', 'apps had a harder day than networks, {app} outages to {net}.',
    'it\'s mostly been application trouble today; networks have been steadier.', 'the apps took the brunt of it today, {app} outages.',
    'application outages outnumber network outages {app} to {net}.', 'today was an app day: {app} app outages, {net} network ones.',
    'the networks behaved; it was the apps that struggled.', 'more apps than networks had problems today, {app} to {net}.']);
  const mixed = X(CTX_OPEN, [
    'the trouble was split fairly evenly between networks and apps.', 'networks and apps shared the pain today, {net} and {app} outages.',
    'it\'s been a mix of network and application outages.', 'about as many app problems as network problems today.',
    'networks and applications both had their moments.', 'a balanced day, if that\'s the word: {net} network and {app} app outages.',
    'no single layer stands out; it\'s a mix.', 'both layers had trouble in similar measure.']);
  const blips = X(CTX_OPEN, [
    'most outages were quick blips, over in a few minutes.', 'the typical outage today was short, just a few minutes.', 'most of today\'s trouble was brief.',
    'short and sharp is the theme today; most outages cleared quickly.', 'the good news is most outages were over in minutes.',
    'most outages were the blink-and-you-miss-it kind.', 'the majority of outages cleared within minutes.', 'today\'s outages were mostly short-lived.']);
  const longest = X(CTX_OPEN, [
    'the longest outage of the day was {N}, at about {mins} minutes.', '{N} had the day\'s longest outage, roughly {mins} minutes.',
    'the marathon of the day: {N}, about {mins} minutes.', 'the longest one was at {N}, lasting about {mins} minutes.',
    '{N} holds the record today, about {mins} minutes down.', 'the longest stretch belongs to {N}, around {mins} minutes.',
    'if you\'re keeping score, {N} had the longest outage, about {mins} minutes.', 'the day\'s longest was {N}, close to {mins} minutes.']);
  const quietSince = X(CTX_OPEN, [
    'nothing new has started in the last {hours} hours.', 'it\'s been about {hours} hours since the last new outage.', 'no fresh outages for about {hours} hours now.',
    'the last {hours} hours have been quiet.', 'the internet has been calm for the last {hours} hours.', 'we\'re on a {hours}-hour streak without a new outage.',
    'all quiet for {hours} hours and counting.', 'no new trouble in roughly {hours} hours.']);
  const edgeDay = X(CTX_OPEN, [
    'CDNs and edge networks had a busy day: {a}, {b} and others.', 'edge providers, including {a} and {b}, had outages today.',
    'it\'s been a rough day at the edge: {a} and {b} both had trouble.', '{n} edge or CDN providers had problems today, {a} and {b} among them.',
    'today\'s list includes CDNs like {a} and {b}, which many websites depend on.', 'edge networks such as {a} and {b} had their share of trouble.',
    'the CDNs, {a} and {b} included, had a bumpy day.', 'several edge providers stumbled today, including {a} and {b}.']);
  const backboneDay = X(CTX_OPEN, [
    'backbone carriers had a busy day: {a}, {b} and others.', 'transit providers, including {a} and {b}, had outages today.',
    'some of the internet\'s highways had trouble today, {a} and {b} among them.', '{n} backbone carriers had problems today, including {a} and {b}.',
    'carriers like {a} and {b} had outages; their problems tend to ripple outward.', 'the backbone wasn\'t spared today: {a} and {b} both had trouble.',
    'transit networks, {a} and {b} included, had a bumpy day.', 'a few backbone carriers stumbled today, {a} and {b} among them.']);
  const cloudDay = X(CTX_OPEN, [
    'the cloud providers had a busy day: {a}, {b} and others.', 'big cloud networks, including {a} and {b}, had outages today.',
    'it\'s been a cloudy day, in the network sense: {a} and {b} both had trouble.', '{n} cloud providers had network problems today, {a} and {b} among them.',
    'cloud networks like {a} and {b} had outages, and lots of apps live there.', 'the clouds weren\'t clear today: {a} and {b} had trouble.',
    'cloud providers, {a} and {b} included, had a bumpy day.', 'a few cloud networks stumbled today, including {a} and {b}.']);
  const hubLead = X(CTX_OPEN, [
    'a lot of today\'s activity touched {hub}.', '{hub} came up again and again today.', 'many of today\'s outages ran through {hub}.',
    '{hub} has been at the center of things today.', '{hub} keeps showing up in today\'s outages.', 'all roads seem to lead through {hub} today.',
    '{hub} was involved in many of today\'s outages.', 'if one place stands out today, it\'s {hub}.']);
  // What a hub is (sources: the APNIC/LACNIC 2026 peering-capacity study; the
  // exchanges' own descriptions). Said as "{hub} is <fact>."
  const HUB_FACTS = {
    Ashburn: ["home to Data Center Alley, one of the densest clusters of data centers in the world", 'where a huge share of US East Coast cloud traffic lives', 'home to some of the biggest cloud regions in the world'],
    Frankfurt: ['home of DE-CIX, one of the largest internet exchanges in the world', "one of Europe's busiest interconnection hubs", 'where a big slice of European traffic meets'],
    Amsterdam: ['home of AMS-IX, one of the major internet exchanges in Europe', 'one of the internet\'s big European crossroads', 'a major meeting point for European networks'],
    London: ['home of LINX, one of the oldest and largest internet exchanges', "one of Europe's biggest interconnection points", 'a key crossroads between Europe and North America'],
    Singapore: ["one of Asia's largest interconnection hubs", 'a landing point for many subsea cables', "home to one of the busiest exchanges in Asia"],
    'Sao Paulo': ['home of IX.br, the largest internet exchange by number of members', "Latin America's biggest interconnection hub", 'where much of Brazil\'s internet meets'],
    Chicago: ['one of the biggest interconnection hubs in the US Midwest', 'home to a major Equinix exchange', 'a key crossroads for North American networks'],
    Dallas: ['a major interconnection hub in the US South', 'home to a major Equinix exchange', 'a key crossroads for networks across the US'],
    'Hong Kong': ['one of the busiest internet hubs in Asia', 'home to a major Equinix exchange', 'a big crossroads for traffic into and out of Asia'],
    Tokyo: ["Japan's main internet hub", 'a major crossroads for traffic across the Pacific', 'one of the biggest interconnection points in Asia'],
    Paris: ['a major European interconnection point', "one of France's main internet hubs", 'a big meeting point for European networks'],
    'New York': ['one of the busiest interconnection points on the US East Coast', 'close to where transatlantic cables land', 'a major crossroads for finance and media traffic'],
    'Los Angeles': ['a gateway for transpacific cables', 'one of the biggest interconnection hubs on the US West Coast', 'a major crossroads for traffic to Asia'],
    'San Jose': ["the heart of Silicon Valley's interconnection", 'home to some of the oldest internet exchange points', 'a major West Coast hub'],
    Seattle: ['a Pacific Northwest gateway for traffic to Asia', 'a major West Coast interconnection point', 'close to some very large cloud campuses'],
    Miami: ['the main gateway between North and Latin America', 'where many subsea cables to Latin America land', 'a key hub for traffic to the Caribbean and South America'],
    Marseille: ['a major landing point for subsea cables to Africa, the Middle East and Asia', "one of Europe's key cable gateways", 'a crossroads for traffic between Europe and Asia'],
    Dublin: ['home to many cloud regions for Europe', 'a favorite location for big cloud data centers', "one of Europe's cloud capitals"],
    Sydney: ["Australia's main internet hub", 'where most of Australia\'s international cables land', "the center of Australia's interconnection"],
    Mumbai: ["India's busiest landing point for subsea cables", "one of India's main internet hubs", 'a crossroads for traffic between India and the world'],
    Johannesburg: ["one of Africa's biggest interconnection hubs", "the center of South Africa's internet", 'a major African meeting point for networks'],
  };
  const hubFact = X(['', 'Worth knowing:', 'For context,', 'By the way,', 'Remember,'], [
    '{hub} is {fact}.', '{hub} is, after all, {fact}.', 'that matters, because {hub} is {fact}.', '{hub} happens to be {fact}.',
    'it\'s no small place: {hub} is {fact}.', 'keep in mind {hub} is {fact}.']);

  // ── What the knowledge base says about a network/app overlap ────────────
  const relUnlikely = X(['', 'One caveat:', 'To be fair,', 'Careful, though:'], [
    "{app} runs on {co}'s own network, so it's unlikely to depend on {net}. The overlap around {city} more likely means a shared building or exchange point, or plain coincidence.",
    "{co} runs its own global network, so {app} probably doesn't sit behind {net}. More likely the two just share a location around {city}.",
    "{co} doesn't need {net} to deliver {app}; it has its own network. So this is {likely} a shared place, not a dependency.",
    "since {co} operates its own backbone, {net} is unlikely to be in {app}'s path. A local event around {city} is the better explanation.",
    "{app} lives on {co}'s own infrastructure, so a {net} outage shouldn't take it down. Same neighborhood, different houses.",
    "{co} has its own network, so {app} and {net} are probably just neighbors around {city}, not partners.",
    "it's tempting to link them, but {co} runs {app} on its own network. The overlap is {likely} about place, not dependency.",
    "{app} and {net} overlapping around {city} doesn't mean one depends on the other; {co} has its own network."]);
  const relKnown = X(['', 'And this one checks out:', 'Notably,'], [
    ' {app} is known to run on {net}, so that link is real.', ' {app} is a known {net} customer, so the connection makes sense.',
    ' {co} is known to use {net}, which makes this more than a coincidence.', " {app} relies on {net}, so this one's {likely} cause and effect.",
    ' {net} is one of the providers {app} is known to use.', ' {app} runs at least partly on {net}, so the overlap fits.'].map((t) => t.trim())).map((t) => ' ' + t);
  const sameCityApart = X(['', 'Note:', 'For what it\'s worth,'], [
    '{a} and {b} both went down around {city} at the same time, but each runs its own network, so it\'s not shared hosting. More likely a shared location or a local event.',
    '{a} and {b} overlap around {city}. They\'re separate companies with their own networks, so the link is {likely} the place, not the platform.',
    '{a} and {b} had trouble together around {city}. Different companies, different networks; probably a shared exchange point or a local event.',
    'around {city}, {a} and {b} failed together. Since each has its own network, look for something local, like power or an exchange point.',
    '{a} and {b}, same city, same time. Not roommates, just neighbors who both lost power, maybe.',
    '{a} and {b} overlapping around {city} {likely} points to the location, since they don\'t share infrastructure.']);

  // ── Insights: new patterns ──────────────────────────────────────────────
  const chain = X(['', 'Look at this sequence:', 'Here\'s a relay of sorts:'], [
    '{a} had a network outage, and {gap} minutes after it cleared, {b} had one in the same place. That\'s {likely} a fault moving between connected networks.',
    'first {a}, then {b}, both around {city}, {gap} minutes apart. They {likely} share a facility or a link.',
    '{b} went down around {city} {gap} minutes after {a} recovered there. One handing trouble to the next, {likely}.',
    '{a} cleared, and {gap} minutes later {b} failed nearby. That kind of relay {likely} points to shared infrastructure.',
    'trouble seems to have hopped from {a} to {b} around {city}, {gap} minutes apart.',
    '{a}, then {b}: back to back in {city}. The baton was passed, and nobody wanted it.',
    'after {a} recovered in {city}, {b} went down {gap} minutes later. {likely} related.',
    'the same city, two networks in a row: {a}, then {b}, {gap} minutes apart.']);
  const aftershock = X(['', 'One to watch:', 'Déjà vu:'], [
    '{N} had trouble around {city}, recovered, and then failed again {gap}. That kind of aftershock usually means the fix didn\'t hold.',
    '{N} came back around {city}, then went down again {gap}. Repeat failures in the same place {likely} share a cause.',
    'around {city}, {N} had a second outage {gap} after the first cleared.', '{N} failed twice around {city}, the second time {gap}.',
    '{N} around {city}: down, up, and down again {gap}. Persistent.', 'the {N} problem around {city} came back {gap}. Aftershocks are a sign something is still unstable.',
    '{N} had a relapse around {city}, {gap}.', 'once wasn\'t enough for {N} around {city}; it came back {gap}.']);
  const workday = X(['', 'Timing matters here:', 'Bad timing:'], [
    "{N}'s outage is active during the workday around {city}, so people there will notice.", "it's the middle of the business day around {city}, and {N} is down there.",
    '{N} picked working hours around {city} to have trouble, so expect complaints.', "{N}'s outage around {city} is landing right in business hours.",
    'around {city} it\'s office hours, and {N} is having a problem. Help desks will be busy.', "{N} is down around {city} while people are working. That's when it hurts.",
    '{N} is having trouble around {city} during the workday. Somebody\'s meeting just froze.', 'business hours around {city}, and {N} is struggling.']);
  // Likely causes, said after a pattern that supports them (research-based).
  const causeRouting = [' Patterns like this often come down to routing, the internet\'s control plane.', ' When it spreads like this, routing changes are a common culprit.',
    ' This kind of spread is often a routing issue rather than broken hardware.', ' A routing change is a frequent cause of patterns like this.',
    ' Routing problems tend to look exactly like this.', ' That points more toward routing than a single broken box.'];
  const causeFiber = [' Physical problems, like a fiber cut, often look like this.', ' A cut cable or a power problem in one place would explain it.',
    ' When one area lights up like this, it\'s often something physical: fiber or power.', ' This has the shape of a local physical fault.',
    ' A fiber cut nearby would cause exactly this kind of ripple.', ' Somebody may have found a buried cable the hard way.'];
  const causeCentral = [' Global failures like this often trace back to a central piece, like sign-in, DNS or a configuration push.',
    ' When one app fails everywhere at once, look at what every region shares: login, DNS, or a global config.',
    ' A configuration change pushed worldwide can do exactly this.', ' Authentication is a classic single point of failure for patterns like this.',
    ' This has the shape of a central service failing, not regional servers.', ' The usual suspects here are identity, DNS, or a bad global rollout.'];
  const causeShared = [' Shared services like DNS, a CDN, or a login provider can cause failures like this.', ' When unrelated services fail together, a shared dependency like DNS or authentication is worth checking.',
    ' Common building blocks such as DNS or sign-in services are often the link.', ' This is how a shared dependency failure usually looks.',
    ' DNS and authentication are easy to forget, but lots of apps depend on them.', ' It\'s often the service everyone relies on that nobody thinks about.'];

  // ── Fivefold expansion ──────────────────────────────────────────────────
  // Each pool is said with a choice of natural lead-ins and endings that fit
  // its sentences, so the same moment comes out many more ways. A lead-in
  // ending in "." starts a new sentence; otherwise the line carries on.
  const lc = (t) => (/^[A-Z][a-z']/.test(t) && !/^(I|I'm|I'll)\b/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);
  const up = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const join = (p, c) => (!p ? c : /[.!?]$/.test(p) ? `${p} ${up(c)}` : `${p} ${lc(c)}`);
  // A line that already opens with its own short lead ("Happily,", "Good news:")
  // doesn't get a second one stacked in front.
  const opened = (c) => /^[A-Z][\w' ]{0,24}[,:] /.test(c) && !/^\{/.test(c);
  const E = (pool, leads, ends = ['']) => {
    const out = [];
    for (const p of leads) for (const c of pool) for (const e of ends) { if (p && !/[.!?]$/.test(p) && opened(c)) continue; out.push(join(p, c) + e); }
    return [...new Set(out)];
  };
  const OVERVIEW_LEAD = ['', 'Okay.', "Here's where things stand.", 'Quick status check.', 'Alright, here\'s the picture.'];
  const WORST_LEAD = ['', "As for who's struggling,", 'Among the providers,', 'Looking at individual services,', 'In terms of providers,', 'If we single one out,'];
  const ROOM_LEAD = ['', 'Finally,', 'And to wrap up,', 'Last but not least,', 'Lastly,', 'And finally,'];
  const TAP_LEAD = ['', 'Okay.', 'Alright.', 'Here we go.', 'Let me tell you about this one.'];
  const TIE_LEAD = ['', 'By the way,', 'Incidentally,', 'For the record,', 'As it happens,', 'Also worth knowing,'];
  const PATH_LEAD = ['', 'Okay.', 'Here we go.', 'Results are in.', 'Trace complete.'];
  const HOP_LEAD = ['', 'Looking at the hops.', 'Hop by hop.', 'Along the route.', 'On the way there.', 'As for the path itself.'];
  const INSIGHT_END = ['', ' Worth keeping in mind.', ' Something to watch.', ' Make of that what you will.', ' Food for thought.'];
  const NOTE_LEAD = ['', 'For context,', 'Keep in mind,', 'Also,', 'That said,', 'Worth knowing:'];
  // A trailing sentence (" It's ...") with a lead-in of its own.
  const ET = (pool, leads) => E(pool.map((t) => t.trim()), leads).map((t) => ' ' + t);

  window.PHRASES = {
    roomDown: E(roomDown, TIE_LEAD), roomSlow: E(roomSlow, TIE_LEAD), roomFine: E(roomFine, TIE_LEAD),
    healthCalm: E(healthCalm, OVERVIEW_LEAD), healthFew: E(healthFew, OVERVIEW_LEAD), healthBusy: E(healthBusy, OVERVIEW_LEAD),
    worstActiveRepeat: E(worstActiveRepeat, WORST_LEAD), worstActiveOne: E(worstActiveOne, WORST_LEAD),
    worstPastRepeat: E(worstPastRepeat, WORST_LEAD), worstPastOne: E(worstPastOne, WORST_LEAD),
    restTail: X(['a few', 'some', 'a couple of', 'a handful of', 'several', 'a few quick', 'some short', 'a couple of brief', 'some minor',
      'a few small', 'a couple of quick', 'some passing', 'a scattering of', 'a few minor', 'some brief', 'a smattering of', 'a few short', 'a pair of',
      'some quick', 'a few passing', 'a couple of short', 'some small', 'a few brief', 'a handful of quick', 'some fleeting'],
      ['hiccups', 'blips', 'glitches', 'bumps', 'wobbles', 'hiccups too', 'blips as well', 'issues', 'disruptions', 'outages of their own',
        'stumbles', 'interruptions', 'outages', 'problems', 'hiccups of their own', 'blips too', 'glitches as well', 'disruptions of their own']),
    overviewRoomFine: E(overviewRoomFine, ROOM_LEAD), overviewRoomDown: E(overviewRoomDown, ROOM_LEAD), overviewRoomSlow: E(overviewRoomSlow, ROOM_LEAD),
    headsUp: E(headsUp, ['', 'Breaking.', 'Fresh one.', 'Attention, please.', 'Just now.']),
    // What went wrong, with an optional detail (it's followed by where).
    whatNetNow: E(whatNetNow, [''], ['', ' for some users', ' affecting users', ' across several sites', " that's still unfolding"]),
    whatAppNow: E(whatAppNow, [''], ['', ' for some users', ' affecting users', ' across several sites', " that's still unfolding"]),
    whatNetThen: E(whatNetThen, [''], ['', ' for some users', ' that affected users', ' across several sites', ' that came and went']),
    whatAppThen: E(whatAppThen, [''], ['', ' for some users', ' that affected users', ' across several sites', ' that came and went']),
    tappedActive: E(tappedActive, TAP_LEAD), tappedCleared: E(tappedCleared, TAP_LEAD),
    pathStart: E(pathStart, [''], ['', ' Give me a moment.', ' Stand by.', ' Hang on.', ' Coming right up.']),
    pathLead: E(pathLead, PATH_LEAD), pathSlow: E(pathSlow, HOP_LEAD), pathLoss: E(pathLoss, HOP_LEAD), pathClean: E(pathClean, HOP_LEAD),
    pathNoAnswer: E(pathNoAnswer, ['', 'Sorry.', 'Hmm.', 'Bad luck.', 'Well.']),
    voiceHello: E(voiceHello, [''], ['', ' How do I sound?', ' Nice to meet you.', " I'll be your narrator.", ' Ready when you are.']),
    speedSample: E(speedSample, [''], ['', ' Let me know.', ' How is that?', ' Tell me if it works.', ' Better?']),
    insightFirst, insightNext,
    sameCompanyFirst: E(sameCompanyFirst, [''], INSIGHT_END), sameCompanyTogether: E(sameCompanyTogether, [''], INSIGHT_END),
    sameCompanyApart: E(sameCompanyApart, [''], INSIGHT_END), netAppFirst: E(netAppFirst, [''], INSIGHT_END),
    netAppTogether: E(netAppTogether, [''], INSIGHT_END), netAppPlain: E(netAppPlain, [''], INSIGHT_END),
    cluster: E(cluster, [''], INSIGHT_END), sharedHosting: E(sharedHosting, [''], INSIGHT_END), sameMinute: E(sameMinute, [''], INSIGHT_END),
    repeatActive: E(repeatActive, [''], INSIGHT_END), repeatPast: E(repeatPast, [''], INSIGHT_END),
    wideNet: E(wideNet, [''], INSIGHT_END), wideApp: E(wideApp, [''], INSIGHT_END), maintenance: E(maintenance, [''], INSIGHT_END),
    insightRoomSlow: ET(insightRoomSlow, NOTE_LEAD), insightRoomDown: ET(insightRoomDown, NOTE_LEAD),
    netTypeEdge: ET(netTypeTail.edge, NOTE_LEAD), netTypeTransit: ET(netTypeTail.transit, NOTE_LEAD), netTypeCloud: ET(netTypeTail.cloud, NOTE_LEAD),
    // New situations
    offHours, bizHours, peakHour, busier, quieter, region, spread, netMost, appMost, mixed, blips, longest, quietSince,
    edgeDay, backboneDay, cloudDay, hubLead, hubFact, HUB_FACTS,
    chain: E(chain, [''], INSIGHT_END), aftershock: E(aftershock, [''], INSIGHT_END), workday: E(workday, [''], INSIGHT_END),
    causeRouting: ET(causeRouting, NOTE_LEAD), causeFiber: ET(causeFiber, NOTE_LEAD), causeShared: ET(causeShared, NOTE_LEAD),
    causeCentral: ET(causeCentral, NOTE_LEAD),
    netTypeNetwork: ET(netTypeTail.network, NOTE_LEAD),
    relUnlikely: E(relUnlikely, [''], INSIGHT_END), relKnown, sameCityApart: E(sameCityApart, [''], INSIGHT_END),
    // Weather for this room's area (js/wxbrief.js): a lead-in, the forecast as
    // the weather service words it, what's next, and any alert in effect.
    wxLead: [
      'And a quick look outside here in {city}.', 'Now, the weather in {city}.', 'Meanwhile, outside in {city}.',
      'Switching to the weather in {city}.', 'Before I go, the weather in {city}.', 'And for the weather here in {city}.',
      'One more thing: the forecast for {city}.', 'Stepping outside for a moment, here in {city}.',
      'Away from the internet, the sky over {city}.', 'Closer to home, the weather in {city}.',
      'Now the local weather for {city}.', 'Let me check the window. {city}.', 'Over to the weather in {city}.',
      'On a different kind of cloud, the forecast for {city}.', 'Rounding things off with the weather in {city}.',
      "Here's the local forecast for {city}.", 'And the outlook outside, in {city}.', "Now, what's happening over {city}.",
      'As for the actual weather in {city}.', 'Not the network kind of storm, the real one. Weather in {city}.',
    ],
    wxNow: ['{period}: {text}', '{period}, {text_l}', 'For {period_l}: {text}', 'Looking at {period_l}: {text}'],
    wxNext: [
      'Then {period_l}, {short}, {hilo} {temp}.', '{period} looks {short_l}, {hilo} {temp}.', 'After that, {period_l}: {short_l}, {hilo} {temp}.',
      'Looking ahead to {period_l}, {short_l} with {hilo} {temp}.', 'And {period_l}, {short_l}, {hilo} {temp}.',
      'Into {period_l}: {short_l}, {hilo} {temp}.',
    ],
    wxAlert: [
      "Heads up, there's a {event} in effect.", 'Worth knowing: a {event} is in effect.', 'Note the {event} in effect for the area.',
      "And there's an active {event} here, so keep an eye on it.", 'The weather service has a {event} out for the area.',
      'Also, a {event} is currently in effect.',
    ],
  };

})();
