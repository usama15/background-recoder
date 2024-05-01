export function setLayoutTimeout(
    callback: (...args: any) => any,
    timeout: number,
    startTime = Date.now(),
    timePassed = 0,
    hasStopped = { current: false }
) {
    if (timePassed > timeout && !hasStopped.current) {
        callback();
        return;
    }
    requestAnimationFrame(() => {
        if (hasStopped.current) return;
        setLayoutTimeout(
            callback,
            timeout,
            startTime,
            Date.now() - startTime,
            hasStopped
        );
    });

    return () => {
        hasStopped.current = true;
    };
}


export function clearLayoutTimeout(
    timeout: ReturnType<typeof setLayoutTimeout>
) {
    timeout();
}

function logToServer(
    type: "error" | "info" | "log" | "debug" | "warn",
    name: string,
    ...data: any[]
) {
    if (typeof console[type] === "function") console[type](...data);
}

export function loggingBuilder(name: string) {
    return {
        log: (...data: any[]) => logToServer("log", name, ...data),
        error: (...data: any[]) => logToServer("error", name, ...data),
        info: (...data: any[]) => logToServer("info", name, ...data),
        debug: (...data: any[]) => logToServer("debug", name, ...data),
        warn: (...data: any[]) => logToServer("warn", name, ...data),
    };
}

export function uuid() {
    //Timestamp
    let date = new Date().getTime();
    //Time in microseconds since page-load or 0 if unsupported
    let performanceDate =
        (performance && performance.now && performance.now() * 1000) || 0;
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
        /[xy]/g,
        (character) => {
            let randomNumber = Math.random() * 16; //random number between 0 and 16
            if (date > 0) {
                //Use timestamp until depleted
                randomNumber = (date + randomNumber) % 16 | 0;
                date = Math.floor(date / 16);
            } else {
                //Use microseconds since page-load if supported
                randomNumber = (performanceDate + randomNumber) % 16 | 0;
                performanceDate = Math.floor(performanceDate / 16);
            }
            return (
                character === "x" ? randomNumber : (randomNumber & 0x3) | 0x8
            ).toString(16);
        }
    );
}