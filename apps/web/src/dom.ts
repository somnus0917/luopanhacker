export const $ = (selector: string, scope: any = document): any => scope.querySelector(selector);

export const $$ = (selector: string, scope: any = document): any[] => [...scope.querySelectorAll(selector)];
