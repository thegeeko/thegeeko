// Place any global data in this file.
// You can import this data from anywhere in your site by using the `import` keyword.

export const SITE_TITLE = "Abdelhadi's Blog";
export const SITE_DESCRIPTION =
  "Abdelhadi's blog and protfolio.";
export const TWITTER_HANDLE = "the_geeko1";
export const MY_NAME = "Abdelhadi";

// setup in astro.config.mjs
const BASE_URL = new URL(import.meta.env.SITE);
export const SITE_URL = BASE_URL.origin;
