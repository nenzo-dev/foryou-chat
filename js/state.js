// The signed-in person, held in one place so every view reads the same copy instead of re-fetching it.
export const state = {
  user: null,     // the Supabase auth user (id, email)
  profile: null,  // the matching row from public.profiles
};

export const isSignedIn = () => !!state.user;
export const isConfigurer = () => !!(state.profile && state.profile.is_configurer);
export const myId = () => state.user && state.user.id;
