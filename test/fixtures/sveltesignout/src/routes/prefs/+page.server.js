export const actions = {
  // Deleting a preference is not signing out — the cookie's name is the evidence,
  // and this action must stay on the worry list.
  reset: async ({ cookies }) => {
    cookies.delete('theme', { path: '/' });
  },
};
