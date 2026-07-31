/**
 * @fileoverview Reaches its helper through a path alias whose mapping lives in a config
 * this fixture deliberately does not carry — so the link is missing from the graph.
 */
import { thing } from '@/lib/thing';

export default function Home() {
  return thing();
}
