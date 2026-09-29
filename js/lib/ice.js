// Which servers a video call uses to find a path between two people. Public STUN only for now (see
// js/config.js) -- most direct connections work fine with just this; a TURN relay can be dropped in
// later using the same currentIce()/refreshIce() shape MindCare's own ice.js uses, without touching
// rtc.js at all.
import { CONFIG } from '../config.js';

export const currentIce = () => CONFIG.iceServers;
export async function refreshIce() { return CONFIG.iceServers; }
