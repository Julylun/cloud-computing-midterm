export function isAuthorizationError(error) {
  if (error?.code === 13) return true;
  return error?.code === 8000
    && error.codeName === 'AtlasError'
    && /not authorized|not allowed to do action|unauthorized/i.test(error.message || '');
}
