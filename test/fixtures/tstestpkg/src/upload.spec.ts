import { makeRandomImage, makeUser } from './generators';

export const scenario = { image: makeRandomImage(), owner: makeUser('nina') };
