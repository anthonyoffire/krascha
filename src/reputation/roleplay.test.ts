import { describe, expect, it } from 'vitest';

import { detectRoleplay } from './roleplay.js';

describe('detectRoleplay', () => {
  it('recognizes requests to embody a distinct character or persona', () => {
    for (const prompt of [
      'Act as Batman.',
      'Pretend to be a pirate.',
      "Roleplay as my grandmother.",
      'Play the role of a dragon.',
      'You are now Darth Vader.',
      "You're a pirate.",
      'Take on the persona of Sherlock Holmes.',
      'Act like someone else.',
      'Speak like a raccoon who just discovered Venmo.',
      'Adopt the identity of an emotionally available swamp monster.',
      "You are Stacy's mom. Do you have it going on?",
    ]) {
      expect(detectRoleplay(prompt), prompt).toBe(true);
    }
  });

  it('does not count functional roles or requests merely discussing characters', () => {
    for (const prompt of [
      'Act as a researcher and summarize this paper.',
      'Pretend you are a helpful research assistant.',
      'Pretend you are an experienced teacher.',
      'You are a helpful assistant.',
      'Explain how roleplay works.',
      'Write a scene where Batman speaks.',
      "Don't act as Batman; tell me about the character.",
      "I don't want you to act as Batman.",
      'Act as a project manager and organize these chaos muffins.',
      "Please don't speak as a soup wizard; explain the recipe instead.",
    ]) {
      expect(detectRoleplay(prompt), prompt).toBe(false);
    }
  });
});
