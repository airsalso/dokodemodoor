.PHONY: all clean build run translate

all: clean build

clean:
	npm run clean

build:
	npm run build

run:
	./run.sh

translate:
	npm run translate-report
